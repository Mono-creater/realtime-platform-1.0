/**
 * alarm-engine.js —— 告警引擎升级（行业需求：分级告警、抑制抖动、缓变早发现、可追溯）
 *
 * 处理链：中值滤波(抗单点尖峰) → 阈值分级 + 变化率(ROC)判据 → 连续确认 → 抑制/去重 → 确认与解除
 * 设计要点：
 *  1) 阈值沿用现场既有取值（温度 80/-10 ℃、压力 1000/100 kPa、湿度 85 %RH），并扩展为
 *     warning/major/critical 三级（standards.ALARM_DEFAULTS，可按线路标定）；
 *  2) 增加变化率判据：对缓慢漂移（如温升 3 ℃/min）可在阈值越限前给出预警，
 *     直接回应“缓变异常发现滞后”的运维痛点；
 *  3) 连续确认（n 点确认/窗口）与抑制窗口（去重）抑制抖动误报；
 *  4) 记录确认人/确认时间/解除时间与来源判据，满足检修留痕与审计要求。
 *
 * 无第三方依赖。
 */

'use strict';

const std = require('./standards');

function median3(a, b, c) { return [a, b, c].sort((x, y) => x - y)[1]; }

class AlarmEngine {
    constructor(opts = {}) {
        this.cfg = Object.assign({
            thresholds: std.ALARM_DEFAULTS,
            rocWindowMs: 60000,      // 变化率统计窗口：1 min
            confirmN: 2,             // 连续确认点数
            suppressMs: 120000,      // 同源同级抑制窗口：2 min
            medianOnly: true,        // true=仅中值滤波（低时延）；false=再叠加 5 点均值
            avgWindow: 5,
            // ---- 变化率通道时间窗持续性投票 ----
            // 滤波序列相邻样本高度相关，超标状态成串出现，"连续 n 点"几乎失效。
            // 改用窗内超标样本占比投票：窗跨度须已满 voteWindowMs，
            // 窗内样本数须不少于 voteMinSamples，超标占比须不低于 voteRatio。
            voteEnabled: true,
            voteWindowMs: 90000,     // 投票窗跨度 Tvote = 90 s
            voteRatio: 0.5,          // 窗内超标样本占比下限 ρ = 50%
            voteMinSamples: 2,       // 窗内最少样本数
            // 窗级斜率模式：以「窗内首尾样本差值 / 窗跨度」估计窗级变化率，
            // 替代逐样本回算。使投票窗可短于 rocWindowMs（逐样本回算要求
            // 每个样本窗龄 ≥ rocWindowMs，当 Tvote < rocWindowMs 时窗内
            // 无一样本可起算，判据恒不成立）。
            //
            // 混合模式（voteSlopeMode='hybrid'）：以窗内短窗（slopeSpanMs）
            // 滑动的斜率逐点判定，得到 0/1 序列，再统计占比 ≥ ρ。
            // 保留"占比投票"语义，同时使 Tvote 可远短于 rocWindowMs。
            voteSlopeMode: 'hybrid',
            slopeSpanMs: 20000,      // 混合模式：窗内滑窗斜率的短窗跨度
        }, opts);
        this.history = [];
        this.thrState = {};           // 阈值通道独立确认状态 signal -> {level, count}
        this.rocState = {};           // 变化率通道独立确认状态 signal -> {level, count}
        this.alarms = [];
        this.suppressed = 0;
        this.voteRejected = 0;       // 投票未通过而拒绝的次数
        this.seq = 0;
    }

    _filter(sample) {
        this.history.push(sample);
        // 缓冲须容纳投票窗；逐样本回算模式（voteSlopeMode=false）还需额外
        // 容纳一个变化率窗，供窗内前端样本回算 roc 时取参照点。
        const spanMs = this.cfg.voteEnabled
            ? (this.cfg.voteSlopeMode === 'hybrid'
                ? Math.max(this.cfg.voteWindowMs, this.cfg.slopeSpanMs)
                : this.cfg.voteSlopeMode
                    ? this.cfg.voteWindowMs
                    : this.cfg.voteWindowMs + this.cfg.rocWindowMs)
            : this.cfg.rocWindowMs;
        const maxHist = Math.max(64, Math.ceil(spanMs / 1000) + 8);
        if (this.history.length > maxHist) this.history.shift();
        const n = this.history.length;
        const out = {};
        for (const sig of ['temperature', 'pressure', 'humidity']) {
            const v1 = this.history[n - 1] ? this.history[n - 1][sig] : undefined;
            const v2 = n >= 2 ? this.history[n - 2][sig] : v1;
            const v3 = n >= 3 ? this.history[n - 3][sig] : v2;
            let v = (v1 === undefined) ? undefined : median3(v3, v2, v1);
            if (!this.cfg.medianOnly) {
                const w = this.history.slice(-this.cfg.avgWindow).map((h) => h[sig]).filter((x) => x !== undefined);
                v = w.reduce((a, b) => a + b, 0) / w.length;
            }
            out[sig] = v;
        }
        return out;
    }

    _roc(sig, now) {
        const h = this.history;
        if (h.length < 2) return 0;
        const ref = h.find((x) => now - x.t >= this.cfg.rocWindowMs) || h[0];
        const cur = h[h.length - 1];
        const dtMin = Math.max((cur.t - ref.t) / 60000, 1 / 60);
        return (cur[sig] - ref[sig]) / dtMin;
    }

    /**
     * 变化率通道的时间窗持续性投票。
     *
     * 判据成立需同时满足三个条件（任一不满足则本次不成立，返回 null）：
     *   (1) 窗跨度已满 voteWindowMs —— 历史不足时判据不成立；
     *   (2) 窗内样本数不少于 voteMinSamples；
     *   (3) 窗内"变化率分级不低于 level"的样本占比不低于 voteRatio。
     *
     * 只对变化率通道生效；阈值通道仍由连续确认点数独立成立，
     * 避免因对变化率施加门控而连带压低本应成立的阈值告警。
     *
     * @returns {?{pass:boolean, ratio:number, n:number, hit:number}}
     */
    _vote(sig, level, now) {
        const c = this.cfg;
        if (!c.voteEnabled) return { pass: true, ratio: 1, n: 0, hit: 0 };

        const win = this.history.filter((h) => now - h.t <= c.voteWindowMs);
        // (1) 窗跨度
        if (win.length < 2 || (now - win[0].t) < c.voteWindowMs) return null;
        // (2) 样本数
        if (win.length < c.voteMinSamples) return null;

        const th = c.thresholds[sig];
        const need = th && th.rocPerMin ? th.rocPerMin : null;

        if (c.voteSlopeMode === 'hybrid') {
            // ---- 混合模式：短窗滑窗斜率 + 占比投票 ----
            // 在投票窗内以 slopeSpanMs 为步长滑窗，逐窗判定"该短窗斜率是否
            // 达到 warning 级变化率"，得到 0/1 序列，再要求其占比 ≥ ρ。
            // 保留占比投票语义，且 Tvote 不必 ≥ rocWindowMs。
            const S = c.slopeSpanMs;
            const marks = [];
            for (let i = 0; i + 1 < win.length; i++) {
                const a = win[i];
                // 找到距 a 约 S 的样本
                let b = null;
                for (let j = i + 1; j < win.length; j++) {
                    if (win[j].t - a.t >= S) { b = win[j]; break; }
                }
                if (!b) break;
                const spanMin = Math.max((b.t - a.t) / 60000, 1 / 60);
                marks.push((b[sig] - a[sig]) / spanMin);
            }
            if (!marks.length) return null;
            const hit = need ? marks.filter((m) => m >= need.warning).length : marks.length;
            const ratio = hit / marks.length;
            return { pass: ratio >= c.voteRatio, ratio, n: marks.length, hit,
                     slope: +(marks[marks.length - 1]).toFixed(3) };
        }

        if (c.voteSlopeMode === true) {
            // ---- 纯窗级斜率模式（ρ 退化为冗余，仅作对照） ----
            const a = win[0], b = win[win.length - 1];
            const spanMin = Math.max((b.t - a.t) / 60000, 1 / 60);
            const slope = (b[sig] - a[sig]) / spanMin;
            if (need) {
                const pass = slope >= need.warning;
                return { pass, ratio: pass ? 1 : 0, n: win.length,
                         hit: pass ? win.length : 0, slope: +slope.toFixed(3) };
            }
            return { pass: true, ratio: 1, n: win.length, hit: win.length };
        }

        // (3) 窗内变化率超标占比 —— 逐样本按其自身时刻重算 roc。
        //     仅统计"已能起算变化率"的样本（窗龄 ≥ rocWindowMs）；
        //     预热样本变化率恒为 0，若计入分母会把真实缓变误判为不达标。
        let hit = 0, valid = 0;
        if (need) {
            for (const h of win) {
                if (now - h.t < c.rocWindowMs) continue;   // 预热样本，不计入
                valid += 1;
                if (this._rocAt(sig, h, h.t) >= need.warning) hit += 1;
            }
        } else {
            valid = win.length; hit = win.length;
        }
        if (valid < c.voteMinSamples) return null;          // 可用样本不足
        const ratio = hit / valid;
        return { pass: ratio >= c.voteRatio, ratio, n: valid, hit };
    }

    /**
     * 按给定信号与样本时刻重算变化率（供投票逐样本回算）。
     * 与 _roc 的区别：_roc 只对最新样本求值，本函数允许指定历史时刻。
     */
    _rocAt(sig, sample, now) {
        const h = this.history;
        if (h.length < 2) return 0;
        const ref = h.find((x) => now - x.t >= this.cfg.rocWindowMs);
        if (!ref) return 0;
        const dtMin = Math.max((now - ref.t) / 60000, 1 / 60);
        return (sample[sig] - ref[sig]) / dtMin;
    }

    /** 单信号阈值分级（仅阈值通道，不含变化率） */
    _gradeThreshold(sig, v) {
        const th = this.cfg.thresholds[sig];
        let lv = 'normal';
        const hi = (lim) => lim !== undefined && v > lim;
        if (hi(th.criticalHigh)) lv = 'critical';
        else if (hi(th.majorHigh)) lv = 'major';
        else if (hi(th.warningHigh)) lv = 'warning';
        else if (th.majorLow !== undefined && v < th.majorLow) lv = 'major';
        else if (th.warningLow !== undefined && v < th.warningLow) lv = 'warning';
        return lv;
    }

    /** 单信号变化率分级（仅变化率通道） */
    _gradeRoc(sig, roc) {
        const th = this.cfg.thresholds[sig];
        let rl = 'normal';
        if (roc !== undefined && th.rocPerMin) {
            if (roc >= th.rocPerMin.major) rl = 'major';
            else if (roc >= th.rocPerMin.warning) rl = 'warning';
        }
        return rl;
    }

    /** 兼容旧调用：阈值 + 变化率取较高者（返回 {level, source}） */
    _grade(sig, v, roc) {
        const lvThr = this._gradeThreshold(sig, v);
        const lvRoc = this._gradeRoc(sig, roc);
        if (std.SEVERITY_ORDER[lvRoc] > std.SEVERITY_ORDER[lvThr]) return { level: lvRoc, source: 'roc' };
        return { level: lvThr, source: 'threshold' };
    }

    /**
     * 推入一个采样（t 为 ms）
     *
     * 双通道解耦（本次修复）：
     *  - 阈值通道：独立于变化率投票门控，连续 confirmN 点确认后即告警，
     *    使快速阶跃越限的告警时延不劣于纯阈值判据。修复原实现中
     *    "变化率通道抢占等级→投票不通过→阈值告警被连带抑制"的缺陷
     *    （原实现下 25→85 ℃ 阶跃越限时延高达约 98 s）。
     *  - 变化率通道：仅当其等级高于阈值通道时，才在时间窗投票通过后抬升告警等级。
     *
     * @returns {Array} 本次新产生的告警
     */
    push(sample) {
        const s = Object.assign({}, sample);
        const f = this._filter(s);
        const out = [];
        for (const sig of ['temperature', 'pressure', 'humidity']) {
            const v = f[sig];
            if (v === undefined) continue;
            const roc = this._roc(sig, s.t);
            const lvThr = this._gradeThreshold(sig, v);
            const lvRoc = this._gradeRoc(sig, roc);

            // 通道 1：阈值独立成立，连续 n 点确认，不受投票门控
            this._confirm(sig, lvThr, 'threshold', s, v, roc, out, this.thrState);

            // 通道 2：变化率仅在等级高于阈值通道时，经投票通过后抬升
            if (std.SEVERITY_ORDER[lvRoc] > std.SEVERITY_ORDER[lvThr]) {
                this._confirm(sig, lvRoc, 'roc', s, v, roc, out, this.rocState);
            } else {
                const st = this.rocState[sig];
                if (st) { st.level = 'normal'; st.count = 0; }
            }
        }
        return out;
    }

    /**
     * 单通道连续确认 + 告警发射。
     * 变化率通道（source==='roc'）须先通过时间窗投票；阈值通道直接发射。
     */
    _confirm(sig, level, source, s, v, roc, out, stateMap) {
        if (std.SEVERITY_ORDER[level] < std.SEVERITY_ORDER.warning) {
            const st = stateMap[sig];
            if (st) { st.level = 'normal'; st.count = 0; }
            return;
        }
        const st = stateMap[sig] || (stateMap[sig] = { level: 'normal', count: 0 });
        if (level === st.level) st.count += 1; else { st.level = level; st.count = 1; }
        if (st.count < this.cfg.confirmN) return;

        // 变化率通道：时间窗投票门控
        let vote = null;
        if (source === 'roc') {
            vote = this._vote(sig, level, s.t);
            if (vote === null) { this.voteRejected += 1; st.count = 0; return; }
            if (!vote.pass)    { this.voteRejected += 1; return; }
        }
        this._emit(sig, level, source, s, v, roc, vote, out);
        st.count = 0; // 发射后复位，交由抑制窗口去重
    }

    /** 告警发射（含同源同级抑制去重） */
    _emit(sig, level, source, s, v, roc, vote, out) {
        const last = this.alarms.filter((a) => a.signal === sig && a.level === level).slice(-1)[0];
        if (last && s.t - last.t < this.cfg.suppressMs) { this.suppressed += 1; return; }
        const alarm = {
            id: ++this.seq,
            t: s.t,
            signal: sig,
            level,
            value: +Number(v).toFixed(2),
            roc: +Number(roc).toFixed(3),
            source,
            vote: vote ? { ratio: +vote.ratio.toFixed(3), n: vote.n, hit: vote.hit } : null,
            threshold: this.cfg.thresholds[sig],
            message: this._message(sig, { level, source }, v, roc),
            status: 'active',
            worker: null, ackAt: null, clearAt: null,
            truthOnsetMs: s.truthOnsetMs !== undefined ? s.truthOnsetMs : null,
            latencyMs: s.truthOnsetMs !== undefined ? Math.round(s.t - s.truthOnsetMs) : null,
        };
        this.alarms.push(alarm);
        out.push(alarm);
    }

    _message(sig, g, v, roc) {
        const th = this.cfg.thresholds[sig], unit = th.unit || '';
        if (g.source === 'roc') return `${sig} 变化率 ${roc.toFixed(2)} ${unit}/min 超过 ${g.level} 级判据`;
        return `${sig} = ${Number(v).toFixed(2)} ${unit} 越限（${g.level}）`;
    }

    ack(id, worker, t) {
        const a = this.alarms.find((x) => x.id === id);
        if (!a) return { ok: false, error: '告警不存在' };
        a.status = 'acked'; a.worker = worker || a.worker; a.ackAt = t || a.ackAt || Date.now();
        return { ok: true, alarm: a };
    }

    clear(id, t) {
        const a = this.alarms.find((x) => x.id === id);
        if (!a) return { ok: false, error: '告警不存在' };
        a.status = 'cleared'; a.clearAt = t || Date.now();
        return { ok: true, alarm: a };
    }

    stats() {
        const byLevel = { warning: 0, major: 0, critical: 0 };
        const lat = [];
        for (const a of this.alarms) { byLevel[a.level] = (byLevel[a.level] || 0) + 1; if (a.latencyMs !== null) lat.push(a.latencyMs); }
        return {
            total: this.alarms.length, byLevel, suppressed: this.suppressed,
            voteRejected: this.voteRejected,
            rocAlarms: this.alarms.filter((a) => a.source === 'roc').length,
            thrAlarms: this.alarms.filter((a) => a.source === 'threshold').length,
            acked: this.alarms.filter((a) => a.status !== 'active').length,
            latency: std.latencyStats(lat),
        };
    }
}

module.exports = { AlarmEngine, median3 };
