/**
 * alarm-engine.js —— 告警引擎（论文 §2.3 / §2.4 / §4.4 的实现）
 *
 * 处理链（论文 §2.3）：
 *   3 点中值滤波 → EWMA 平滑 → 分级判定（阈值分级 与 EWMA 趋势检测 并行判定）
 *   → 取较高等级 → 抑制去重 → 确认与解除留痕
 *
 * ⚠ 本次升级的核心（论文 §2.4）：
 *   旧实现的变化率通道采用"时间窗持续性投票"（Tvote=90 s、ρ=0.5、nmin=2）——
 *   那是论文中已被淘汰的【过渡方案】：窗口参数须凭经验设定，
 *   且无法给出误报率的解析表达式。
 *   本实现改为论文的【根治方案】：
 *     1) 阈值通道与变化率通道共用【同一条】EWMA 序列（滤波不一致从根源消除）；
 *     2) 变化率取 EWMA 序列在窗口 W 上的差分 roc = (Zi − Zi−W)/W（式5）；
 *     3) 统计窗口与轮询周期解耦（缓冲按时间裁剪，"年龄最接近 W"的样本作差分基准）；
 *     4) 误报率由式(6)(12) 解析校核（δmin = 3σr ≤ rw），不再凭经验试凑；
 *     5) 确认方式为"连续 n 点同级"（默认 n = 2）——在 EWMA 序列上，
 *        因差分是【跨窗口】统计量而非相邻样本差分，序列相关性传导被显著削弱。
 *
 * 分级阈值（standards.ALARM_DEFAULTS，与论文一致）：
 *   温度 80/90/100 ℃（低限 −10/−20）、压力 1 000/1 100/1 200 kPa（低限 100/80）、
 *   湿度 85/92/97 %RH；变化率：温度 2/5 ℃·min⁻¹、压力 80/200 kPa·min⁻¹、湿度 5/12 %RH·min⁻¹。
 *
 * 无第三方依赖。
 */

'use strict';

const std = require('./standards');
const { EwmaTrendDetector, sigmaRoc, deltaMin, sigmaMax } = require('./ewma-trend');

/** 参与判定的三路信号（阈值配置键名） */
const SIGNALS = ['temperature', 'pressure', 'humidity'];

/** 阈值配置键名 ⇄ 检测器内部短名（EwmaTrendDetector 使用 temp/press/humid） */
const SIG_KEY = { temperature: 'temp', pressure: 'press', humidity: 'humid' };

class AlarmEngine {
    constructor(opts = {}) {
        this.cfg = Object.assign({
            thresholds: std.ALARM_DEFAULTS,
            confirmN: 2,             // 连续确认点数 n（论文默认 2）
            suppressMs: 120000,      // 同源同级抑制窗口（论文默认 120 s）
            // ---- EWMA 趋势检测（论文 §2.4）----
            lambda: 0.2,             // EWMA 平滑系数 λ（论文取 0.2，图6 表明 0.2~0.5 稳健）
            windowMin: 1.0,          // 变化率统计窗口 W（论文取 60 s = 1 min）
            sigma: 1.0,              // 传感器噪声标准差 σ（用于式(6)(12) 解析校核，可现场标定）
            noiseCheck: true,        // 是否校核 δmin ≤ rw（论文 §4.4）
            coldStartProtectMs: 0,   // 15 s 冷启动保护（论文 P117，误报率评估类试验启用；默认关闭，不影响表10 检出时延）
        }, opts);

        this.detector = new EwmaTrendDetector({
            lambda: this.cfg.lambda,
            windowMin: this.cfg.windowMin,
            sigma: this.cfg.sigma,
            confirmN: this.cfg.confirmN,
            coldStartProtectMs: this.cfg.coldStartProtectMs,
        });

        this.state = {};              // signal -> {level, count}
        for (const sig of SIGNALS) this.state[sig] = { level: 'normal', count: 0 };

        this.alarms = [];
        this.suppressed = 0;
        this.seq = 0;
        /** 内存中保留的告警条数上限：长期运行避免数组无限增长（统计口径取当前窗口） */
        this.maxAlarms = this.cfg.maxAlarms || 2000;
        /** 噪声边界告警（δmin > rw，判据不可分辨） */
        this.noiseWarnings = [];
    }

    /** 运行期标定噪声水平（现场按实测传感器噪声设定，论文 §4.4） */
    setSigma(sigma) {
        this.cfg.sigma = sigma;
        this.detector.setSigma(sigma);
    }

    /** 解析指标：σeff、σZ、σr、δmin、噪声边界 σmax、工程裕度（供 /api/v2/ewma/analytics） */
    analytics() {
        const rwBy = {
            temperature: this.cfg.thresholds.temperature.rocPerMin.warning,
            pressure: this.cfg.thresholds.pressure.rocPerMin.warning,
            humidity: this.cfg.thresholds.humidity.rocPerMin.warning,
        };
        return this.detector.analytics(rwBy);
    }

    /** 单信号分级：阈值分级 与 变化率分级 取较高者（论文 §2.3） */
    _grade(sig, v, roc) {
        const th = this.cfg.thresholds[sig];
        let lv = 'normal', src = null;
        const hi = (lim) => lim !== undefined && v > lim;
        if (hi(th.criticalHigh)) { lv = 'critical'; src = 'threshold'; }
        else if (hi(th.majorHigh)) { lv = 'major'; src = 'threshold'; }
        else if (hi(th.warningHigh)) { lv = 'warning'; src = 'threshold'; }
        else if (th.majorLow !== undefined && v < th.majorLow) { lv = 'major'; src = 'threshold'; }
        else if (th.warningLow !== undefined && v < th.warningLow) { lv = 'warning'; src = 'threshold'; }

        if (roc !== null && roc !== undefined && th.rocPerMin) {
            let rl = 'normal';
            if (roc >= th.rocPerMin.major) rl = 'major';
            else if (roc >= th.rocPerMin.warning) rl = 'warning';
            if (std.SEVERITY_ORDER[rl] > std.SEVERITY_ORDER[lv]) { lv = rl; src = 'roc'; }
        }
        return { level: lv, source: src };
    }

    /**
     * 推入一个采样（t 为 ms）
     * @returns {Array} 本次新产生的告警
     */
    push(sample) {
        const s = Object.assign({}, sample);
        const { filtered, roc } = this.detector.update(s);
        // 最近一帧的滤波值/变化率（供 pipeline 复用，避免二次调用 det.update 造成重复入窗）
        this.lastFrame = { t: s.t, filtered, roc };
        const out = [];

        for (const sig of SIGNALS) {
            const key = SIG_KEY[sig];
            const v = filtered[key];
            if (v === undefined || v === null) continue;

            const r = roc[key];
            const g = this._grade(sig, v, r);
            const st = this.state[sig];

            if (std.SEVERITY_ORDER[g.level] >= std.SEVERITY_ORDER.warning) {
                if (g.level === st.level) st.count += 1; else { st.level = g.level; st.count = 1; }

                if (st.count >= this.cfg.confirmN) {
                    // 抑制去重：按（信号，等级）在抑制窗口内只保留首条（论文 §2.3）
                    const last = this.alarms.filter((a) => a.signal === sig && a.level === g.level).slice(-1)[0];
                    if (last && s.t - last.t < this.cfg.suppressMs) { this.suppressed += 1; continue; }

                    const alarm = {
                        id: ++this.seq,
                        t: s.t,
                        signal: sig,
                        level: g.level,
                        value: +Number(v).toFixed(2),
                        roc: r === null ? null : +Number(r).toFixed(3),
                        source: g.source,
                        // 判据口径留痕：式(6)(12) 解析值
                        sigmaRoc: +sigmaRoc(this.cfg.sigma, this.cfg.lambda, this.cfg.windowMin).toFixed(4),
                        deltaMin: +deltaMin(this.cfg.sigma, this.cfg.lambda, this.cfg.windowMin).toFixed(4),
                        threshold: this.cfg.thresholds[sig],
                        message: this._message(sig, g, v, r),
                        status: 'active',
                        worker: null, ackAt: null, clearAt: null,
                        truthOnsetMs: s.truthOnsetMs !== undefined ? s.truthOnsetMs : null,
                        latencyMs: s.truthOnsetMs !== undefined ? Math.round(s.t - s.truthOnsetMs) : null,
                    };
                    this.alarms.push(alarm);
                    if (this.alarms.length > this.maxAlarms) {
                        this.alarms.splice(0, this.alarms.length - this.maxAlarms);
                    }
                    out.push(alarm);
                }
            } else {
                st.level = 'normal'; st.count = 0;
            }
        }

        // 噪声边界校核（论文 §4.4：投运前须按式(12) 校核噪声与变化率门限的匹配关系）
        if (this.cfg.noiseCheck) {
            const dm = deltaMin(this.cfg.sigma, this.cfg.lambda, this.cfg.windowMin);
            for (const sig of SIGNALS) {
                const rocCfg = this.cfg.thresholds[sig] && this.cfg.thresholds[sig].rocPerMin;
                if (!rocCfg || rocCfg.warning === undefined) continue;   // 该通道未启用变化率判据
                const rwW = rocCfg.warning;
                if (dm > rwW) {
                    const smax = sigmaMax(rwW, this.cfg.lambda, this.cfg.windowMin);
                    const last = this.noiseWarnings.slice(-1)[0];
                    if (!last || last.sig !== sig || s.t - last.t > 3600000) {
                        this.noiseWarnings.push({
                            t: s.t, sig, deltaMin: +dm.toFixed(3), rw: rwW, sigmaMax: +smax.toFixed(2),
                        });
                    }
                }
            }
        }
        return out;
    }

    _message(sig, g, v, roc) {
        const th = this.cfg.thresholds[sig], unit = th.unit || '';
        if (g.source === 'roc') {
            return `${sig} 变化率 ${Number(roc).toFixed(2)} ${unit}/min 达到 ${g.level} 级判据（EWMA 趋势检测，窗口 ${this.cfg.windowMin} min）`;
        }
        return `${sig} = ${Number(v).toFixed(2)} ${unit} 越限（${g.level}，EWMA 平滑值）`;
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
        for (const a of this.alarms) {
            byLevel[a.level] = (byLevel[a.level] || 0) + 1;
            if (a.latencyMs !== null) lat.push(a.latencyMs);
        }
        return {
            total: this.alarms.length, byLevel, suppressed: this.suppressed,
            rocAlarms: this.alarms.filter((a) => a.source === 'roc').length,
            thrAlarms: this.alarms.filter((a) => a.source === 'threshold').length,
            acked: this.alarms.filter((a) => a.status !== 'active').length,
            latency: std.latencyStats(lat),
            noiseWarnings: this.noiseWarnings.slice(-5),
            ewma: {
                lambda: this.cfg.lambda, windowMin: this.cfg.windowMin, sigma: this.cfg.sigma,
                sigmaRoc: +sigmaRoc(this.cfg.sigma, this.cfg.lambda, this.cfg.windowMin).toFixed(4),
                deltaMin: +deltaMin(this.cfg.sigma, this.cfg.lambda, this.cfg.windowMin).toFixed(4),
            },
        };
    }
}

module.exports = { AlarmEngine };
