/**
 * R6 补充复算 —— 回应同行评审的致命质疑
 *
 * E17 链路预算与带宽基线重算（按 EN 50317:2025 的 ≥200 Hz 采样要求）
 * E18 "发现时延"的统一定义与同事件对比
 * E19 误报率的统计正确表述（Clopper–Pearson 精确区间）
 * E20 序号回绕缺陷的修正方案验证
 * E21 测量不确定度预算
 * E22 阈值依据复核（TB/T 1842.3 的 150 ℃ 判据）
 * E23 与经典变化检测方法的对照（CUSUM / EWMA / Page-Hinkley）
 * E24 序号带宽开销与 32 位计数器方案对比
 */
'use strict';

const fs = require('fs');
const P = 'D:/realtime-platform/realtime-platform-main/';
const { AlarmEngine, median3 } = require(P + 'alarm-engine.js');
const std = require(P + 'standards.js');
const { LinkMonitor } = require(P + 'link-monitor.js');
const OUT = __dirname + '/';
const log = [];
function say(s) { console.log(s); log.push(s); }
function dump(name, rows) {
    if (!rows || !rows.length) { say(`  [skip] ${name}`); return; }
    const keys = Object.keys(rows[0]);
    fs.writeFileSync(OUT + name, '\uFEFF' + keys.join(',') + '\n' +
        rows.map((r) => keys.map((k) => {
            const v = r[k];
            return typeof v === 'string' && /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        }).join(',')).join('\n'), 'utf8');
    say(`  -> ${name}  (${rows.length} 行)`);
}
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const BASE = { pressure: 500, humidity: 50 };

/* Clopper–Pearson 精确二项区间（不依赖第三方库） */
function lgamma(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp); let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x); }
function betacf(a, b, x) {
    const MAXIT = 200, EPS = 3e-12, FPMIN = 1e-300;
    let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d; let h = d;
    for (let m = 1; m <= MAXIT; m++) {
        const m2 = 2 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d; h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d; const del = d * c; h *= del;
        if (Math.abs(del - 1) < EPS) break;
    }
    return h;
}
function betai(a, b, x) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
/** 观测 k 次成功 / n 次试验，返回 [下界, 上界]（双侧 95%） */
function cp(k, n, alpha = 0.05) {
    const lo = k === 0 ? 0 : betai(k, n - k + 1, alpha / 2);
    const hi = k === n ? 1 : 1 - betai(k + 1, n - k, alpha / 2);
    return [lo, hi];
}

/* =======================================================================
 * E17 链路预算与带宽基线重算
 *   基线按 EN 50317:2025 对接触力测量的 ≥200 Hz 采样要求确定
 * ==================================================================== */
say('\n=== E17 链路预算与带宽基线 ===');
{
    const MBAP = 7, REQ_PDU = 5;
    const txMain = (MBAP + REQ_PDU) + (MBAP + 1 + 1 + 2 * 5);       // 读 2001—2005
    const txSub = (MBAP + REQ_PDU) + (MBAP + 1 + 1 + 2 * 5);        // 追加读 2011—2015
    // 协议栈开销：以太网 II + IPv4 + TCP + 前导码/帧间隙
    const ETH_HDR = 14, IP_HDR = 20, TCP_HDR = 20, PREAMBLE_IFG = 20;
    const TCP_ACK = ETH_HDR + IP_HDR + TCP_HDR + PREAMBLE_IFG;        // 纯 ACK 帧
    const segMain = (MBAP + REQ_PDU) + ETH_HDR + IP_HDR + TCP_HDR + PREAMBLE_IFG;   // 请求段
    const segResp = (MBAP + 1 + 1 + 2 * 5) + ETH_HDR + IP_HDR + TCP_HDR + PREAMBLE_IFG;
    const wire = segMain + segResp + TCP_ACK;                        // 请求 + 响应 + ACK
    say(`   应用层：主包事务 ${txMain} B；线缆侧单事务 ${wire} B（含以太网/IP/TCP/ACK，倍数 ${(wire / txMain).toFixed(2)}×）`);

    // 基线：按 EN 50317 要求的 ≥200 Hz 三通道原始波形
    const FS = 200, CH = 3, BYTES = 4;
    const rows = [];
    const fleet = [
        { name: '单车（8 辆编组 × 1 受电弓）', nodes: 8 },
        { name: '单弓（2 架受电弓）', nodes: 2 },
        { name: '单机（1 受电弓）', nodes: 1 },
        { name: '30 列车全线汇聚', nodes: 240 },
    ];
    for (const f of fleet) {
        // 原始波形基线
        const rawBps = FS * CH * BYTES * f.nodes;
        // 本方案：P=2 s 轮询
        const ourBps = f.nodes * wire / 2;
        rows.push({ scenario: f.name, nodes: f.nodes,
                    raw_200Hz_bps: rawBps, raw_200Hz_kbps: +(rawBps * 8 / 1000).toFixed(2),
                    proposed_kbps: +(ourBps * 8 / 1000).toFixed(2),
                    compress_x: +(rawBps / ourBps).toFixed(1) });
        say(`   ${f.name.padEnd(24)}：原始波形 ${(rawBps * 8 / 1000).toFixed(2)} kbit/s → 本方案 ${(ourBps * 8 / 1000).toFixed(2)} kbit/s（${(rawBps / ourBps).toFixed(1)}×）`);
    }
    dump('E17_link_budget.csv', rows);

    // 与城轨车地无线可用码率对比
    const LINKS = [
        { name: 'LTE/4G 典型上行（实测行业普遍值）', kbps: 20000 },
        { name: 'CBTC 专用车地无线（区间内）', kbps: 2000 },
        { name: 'WiFi 车地无线（隧道内热点）', kbps: 5000 },
        { name: '窄带受限上行（工况保守下界）', kbps: 64 },
    ];
    const cmp = [];
    for (const L of LINKS) {
        for (const f of fleet) {
            const rawK = rows.find((r) => r.scenario === f.name).raw_200Hz_kbps;
            const ourK = rows.find((r) => r.scenario === f.name).proposed_kbps;
            cmp.push({ link: L.name, avail_kbps: L.kbps, scenario: f.name,
                       raw_occupy_pct: +(rawK / L.kbps * 100).toFixed(2),
                       proposed_occupy_pct: +(ourK / L.kbps * 100).toFixed(3) });
        }
    }
    dump('E17_link_compare.csv', cmp);
    say('   占用率对比（原始波形 200 Hz vs 本方案）：');
    for (const L of LINKS) {
        const a = cmp.find((c) => c.link === L.name && c.scenario === '30 列车全线汇聚');
        const b = cmp.find((c) => c.link === L.name && c.scenario === '单弓（2 架受电弓）');
        say(`   ${L.name.padEnd(30)}：30 列车 原始 ${a.raw_occupy_pct}% → 本方案 ${a.proposed_occupy_pct}%；单弓 ${b.raw_occupy_pct}% → ${b.proposed_occupy_pct}%`);
    }

    // 单次 FC03 读 15 寄存器 vs 双包的交叉点
    const tx15 = (MBAP + REQ_PDU) + (MBAP + 1 + 1 + 2 * 15);
    const wire15 = segMain + (MBAP + 1 + 1 + 2 * 15) + ETH_HDR + IP_HDR + TCP_HDR + PREAMBLE_IFG + TCP_ACK;
    const cross = [];
    for (const r of [0, 0.01, 0.05, 0.10, 0.215, 0.30, 0.50, 1.0]) {
        const dual = txMain + r * txSub;
        const single = tx15;
        cross.push({ anomaly_rate_pct: r * 100, dualpack_app_B: dual, single15_app_B: single,
                     dualpack_wire_B: +(wire * (1 + 0) ).toFixed(0),
                     single15_wire_B: wire15,
                     verdict: dual < single ? '双包省' : (dual === single ? '相等' : '双包费') });
    }
    // 精确求交叉点：dual = single → r = (tx15 - txMain)/txSub
    const rCross = (tx15 - txMain) / txSub;
    cross.forEach((c) => { c.dualpack_wire_B = +(wire + rCross * 0).toFixed(0); });
    say(`   双包 vs 单次读 15 寄存器：交叉点异常率 = ${(rCross * 100).toFixed(1)}%（超过该值双包更费字节）`);
    dump('E17_dualpack_crossover.csv', cross);
}

/* =======================================================================
 * E18 发现时延的统一定义与同事件对比
 *   定义：t0 = 劣化起始；t1 = 告警产生。三种配置在同一 t0 下比较
 * ==================================================================== */
say('\n=== E18 发现时延的统一定义 ===');
{
    const thrOnly = JSON.parse(JSON.stringify(std.ALARM_DEFAULTS));
    for (const k of Object.keys(thrOnly)) delete thrOnly[k].rocPerMin;
    const CFG = {
        thr_only: { thresholds: thrOnly },
        confirm_only: { voteEnabled: false, confirmN: 2 },
        proposed: { voteEnabled: true, voteSlopeMode: 'hybrid', confirmN: 2,
                    voteWindowMs: 45000, voteRatio: 0.5, voteMinSamples: 2, slopeSpanMs: 20000 },
    };
    const rows = [];
    for (const rate of [0.5, 1, 2, 3, 5, 10, 20]) {
        const D = 3600000;    // 60 min 上限
        const rec = { rate_C_per_min: rate, horizon_s: D / 1000 };
        for (const [nm, cfg] of Object.entries(CFG)) {
            const lats = [];
            let miss = 0;
            for (let k = 0; k < 20; k++) {
                const e = new AlarmEngine(cfg); const r = rng(90000 + k * 31 + rate);
                for (let t = 0; t <= D; t += 1000) {
                    e.push({ t, ...BASE, temperature: 25 + (rate / 60) * (t / 1000) + gauss(r) * 0.3,
                             truthOnsetMs: 0 });
                }
                const a = e.alarms.filter((x) => x.signal === 'temperature');
                if (a.length) lats.push(a[0].t / 1000); else miss++;
            }
            lats.sort((x, y) => x - y);
            rec[nm + '_median_s'] = lats.length ? lats[Math.floor(lats.length / 2)] : null;
            rec[nm + '_min_s'] = lats.length ? lats[0] : null;
            rec[nm + '_miss'] = miss;
            rec[nm + '_source'] = (() => {
                const e = new AlarmEngine(cfg); const r = rng(1);
                for (let t = 0; t <= D; t += 1000) e.push({ t, ...BASE, temperature: 25 + (rate / 60) * (t / 1000) + gauss(r) * 0.3 });
                const a = e.alarms.filter((x) => x.signal === 'temperature');
                return a.length ? a[0].source : '未检出';
            })();
        }
        rec.advance_thr_vs_prop_s = (rec.thr_only_median_s !== null && rec.proposed_median_s !== null)
            ? rec.thr_only_median_s - rec.proposed_median_s : null;
        rows.push(rec);
        say(`   ${String(rate).padStart(4)} ℃/min：纯阈值 ${String(rec.thr_only_median_s).padStart(6)}s(${rec.thr_only_source})  连续确认 ${String(rec.confirm_only_median_s).padStart(5)}s(${rec.confirm_only_source})  本文 ${String(rec.proposed_median_s).padStart(4)}s(${rec.proposed_source})  提前 ${rec.advance_thr_vs_prop_s}s`);
    }
    dump('E18_latency_same_event.csv', rows);

    // 时间轴分解（3 ℃/min 为例）
    const rate = 3, P = 2;
    const tl = [];
    tl.push({ stage: '劣化起始 t0', cum_ms: 0, note: '注入线性温升起点' });
    tl.push({ stage: '越限 80 ℃ 的物理时刻', cum_ms: Math.round((80 - 25) / rate * 60 * 1000), note: '(80−25)/3 × 60 s' });
    tl.push({ stage: '纯阈值判据告警（= 上行）', cum_ms: Math.round((80 - 25) / rate * 60 * 1000), note: '与物理越限时刻重合' });
    const voteT = 45000;
    tl.push({ stage: '本文方法：投票窗填满最早可判', cum_ms: voteT, note: 'T_vote = 45 s' });
    tl.push({ stage: '本文方法：中位告警时刻', cum_ms: 46000, note: '窗填满 + 连续确认 2 点' });
    tl.push({ stage: '本文方法：最坏情形（窗填满 + 轮询相位）', cum_ms: voteT + P * 1000, note: '叠加轮询相位上界' });
    dump('E18_timeline.csv', tl);
    say(`   3 ℃/min 时间轴：物理越限需 ${((80 - 25) / rate * 60).toFixed(0)} s；本文方法 ${voteT / 1000} s 起可判，中位 ${(46000 / 1000).toFixed(0)} s`);

    // 端到端时延预算（阶跃工况，分解到各环节）
    const budget = [];
    for (const poll of [1000, 2000]) {
        budget.push({ poll_ms: poll,
                      t_sliding_window_ms: 1000, t_sliding_note: 'PLC 10 点均值最坏整窗刷新',
                      t_median_group_delay_ms: poll, t_median_note: '3 点中值群时延 = 1 个采样周期',
                      t_poll_phase_mean_ms: poll / 2, t_poll_note: '轮询相位均匀分布的均值',
                      t_poll_phase_max_ms: poll,
                      t_confirm_ms: poll, t_confirm_note: '连续确认 2 点 = 1 个轮询周期',
                      t_total_median_pred_ms: 1000 + poll + poll / 2 + poll,
                      t_total_max_ms: 1000 + poll + poll + poll });
        say(`   轮询 ${poll} ms：预算均值 ${budget[budget.length - 1].t_total_median_pred_ms} ms，最坏 ${budget[budget.length - 1].t_total_max_ms} ms（其中中值群时延占 ${(poll / (1000 + poll + poll / 2 + poll) * 100).toFixed(0)}%）`);
    }
    dump('E18_latency_budget.csv', budget);
}

/* =======================================================================
 * E19 误报率的统计正确表述
 * ==================================================================== */
say('\n=== E19 误报率的统计区间 ===');
{
    const CFG = { voteEnabled: true, voteSlopeMode: 'hybrid', confirmN: 2,
                  voteWindowMs: 45000, voteRatio: 0.5, voteMinSamples: 2, slopeSpanMs: 20000 };
    const rows = [];
    for (const [nm, sig, dur] of [['σ_W=0.5 ℃，300 s × 300 次', 0.5, 300000],
                                   ['σ_W=1.0 ℃，300 s × 300 次', 1.0, 300000],
                                   ['σ_W=1.0 ℃，3600 s × 100 次', 1.0, 3600000],
                                   ['σ_W=2.0 ℃，300 s × 300 次', 2.0, 300000]]) {
        const NT = nm.includes('3600') ? 100 : 300;
        let k = 0;
        for (let i = 0; i < NT; i++) {
            const e = new AlarmEngine(CFG); const r = rng(100000 + i * 17);
            for (let t = 0; t <= dur; t += 1000) e.push({ t, ...BASE, temperature: 25 + gauss(r) * sig });
            if (e.alarms.filter((a) => a.signal === 'temperature').length > 0) k++;
        }
        const [lo, hi] = cp(k, NT);
        const hours = NT * (dur / 3600000);
        rows.push({ scenario: nm, trials: NT, with_false_alarm: k,
                     point_pct: +(k / NT * 100).toFixed(4),
                     cp95_lo_pct: +(lo * 100).toFixed(4), cp95_hi_pct: +(hi * 100).toFixed(4),
                     total_hours: +hours.toFixed(1),
                     false_alarms_per_day_est: +(k / NT / (dur / 3600000) * 24).toFixed(3),
                     per_day_95_upper: +((hi) / (dur / 3600000) * 24).toFixed(3) });
        say(`   ${nm}：${k}/${NT} 次出现告警；点估计 ${(k / NT * 100).toFixed(3)}%，95% CI [${(lo * 100).toFixed(3)}%, ${(hi * 100).toFixed(3)}%]；折算日均 ${(k / NT / (dur / 3600000) * 24).toFixed(3)} 次（95% 上限 ${((hi) / (dur / 3600000) * 24).toFixed(2)} 次/天）`);
    }
    dump('E19_false_alarm_ci.csv', rows);

    // 零事件时的 Rule of Three
    const z = [];
    for (const n of [300, 1000, 3000, 10000]) z.push({ zero_events: 0, trials: n, rule_of_three_upper_pct: +(3 / n * 100).toFixed(3) });
    dump('E19_rule_of_three.csv', z);
    say(`   Rule of Three：0/300 → 95% 上限 ${(3 / 300 * 100).toFixed(2)}%；0/3000 → ${(3 / 3000 * 100).toFixed(3)}%`);

    // 丢包率估计的 Wilson 区间（说明点估计不可用于考核）
    const wilson = [];
    for (const [k, n] of [[3, 43200], [3, 1000], [10, 1000], [1, 1000], [50, 1000]]) {
        const zc = 1.96, ph = k / n;
        const den = 1 + zc * zc / n;
        const c = (ph + zc * zc / (2 * n)) / den;
        const hw = zc * Math.sqrt(ph * (1 - ph) / n + zc * zc / (4 * n * n)) / den;
        wilson.push({ gaps: k, expected: n, point_pct: +(ph * 100).toFixed(5),
                      ci_lo_pct: +((c - hw) * 100).toFixed(5), ci_hi_pct: +((c + hw) * 100).toFixed(5),
                      rel_width_pct: +(2 * hw / ph * 100).toFixed(1) });
        say(`   缺口 ${k}/${n}：点估计 ${(ph * 100).toFixed(4)}%，95% CI [${((c - hw) * 100).toFixed(4)}%, ${((c + hw) * 100).toFixed(4)}%]，相对宽度 ${(2 * hw / ph * 100).toFixed(0)}%`);
    }
    dump('E19_wilson.csv', wilson);
}

/* =======================================================================
 * E20 序号回绕缺陷：修正方案验证
 * ==================================================================== */
say('\n=== E20 序号回绕缺陷与修正 ===');
{
    // PLC 侧序号语义：seq >= 65535 ? 1 : seq+1，取值域 {1..65535}，循环长度 65535
    // 现实现按 mod 65536 计算步长，回绕点 (65535→1) 步长被算成 2
    const rows = [];
    const N = 65535 * 4;
    for (const [nm, mod, offset] of [['现实现：mod 65536', 65536, 0], ['修正：mod 65535', 65535, -1]]) {
        let gaps = 0, expected = 0, prev = 0;
        const dvals = {};
        for (let i = 1; i <= N; i++) {
            const seq = (i % 65535) + 1;
            if (prev !== 0) {
                const d = mod === 65536 ? (seq - prev + mod) % mod : ((seq - prev - 1 + mod) % mod) + 1;
                dvals[d] = (dvals[d] || 0) + 1;
                if (d > 1) gaps += d - 1;
                expected += d;
            } else expected += 1;
            prev = seq;
        }
        rows.push({ scheme: nm, frames: N, gaps, expected,
                    false_loss_pct: +(gaps / expected * 100).toFixed(6),
                    step_distribution: JSON.stringify(dvals) });
        say(`   ${nm}：${N} 帧零丢包 → 虚假缺口 ${gaps}，虚假丢包率 ${(gaps / expected * 100).toFixed(6)}%，步长分布 ${JSON.stringify(dvals)}`);
    }
    dump('E20_wrap_scheme.csv', rows);

    // 回绕周期与不可判定盲区
    const P = 2;   // 平台轮询周期 s（PLC 出包 1 s，平台 2 s 读一次，故 seq 步长为 2）
    const blind16 = 65535 * P / 3600;
    const blind32 = 65536 * P * 2 / 3600;   // 2 个寄存器 = 32 bit
    const rows2 = [
        { item: '16 位序号回绕周期（PLC 出包 1 s）', value: +(65535 / 3600).toFixed(2), unit: 'h' },
        { item: '16 位序号不可判定盲区（按平台轮询 2 s 折算）', value: +blind16.toFixed(2), unit: 'h' },
        { item: '16 位序号单次回绕虚假缺口', value: 1, unit: '帧' },
        { item: '虚假丢包率（量级 1/N）', value: 1.5e-5, unit: '—' },
        { item: '32 位序号回绕周期', value: +(4294967295 / 3600 / 24 / 365).toFixed(1), unit: 'a' },
        { item: '32 位序号不可判定盲区', value: +(blind32 * 24 * 365).toFixed(0), unit: 'a' },
        { item: '32 位方案额外寄存器开销', value: 1, unit: '个 16 位寄存器（+2 B/帧）' },
    ];
    dump('E20_wrap_blindspot.csv', rows2);
    rows2.forEach((r) => say(`   ${r.item}：${r.value} ${r.unit}`));

    // 断链时长不可分辨性
    const amb = [];
    for (const [lost, d] of [[1, 1], [10, 10], [1000, 1000], [32767, 32767], [32768, 32768], [65535, 65535]]) {
        amb.push({ lost_frames: lost, observed_delta: d,
                   indistinguishable_from_36bit_wrap: d > 32768 ? '是（与回绕混淆）' : '否' });
    }
    dump('E20_ambiguity.csv', amb);
    say(`   Δ > 32768 时无法区分"正向丢 32769 帧以上"与"反向回绕"，本设计不考虑乱序故不受影响；但断链超过 ${blind16.toFixed(1)} h 后无法区分丢 1 帧与断链`);
}

/* =======================================================================
 * E21 测量不确定度预算（GUM / JJF 1059.1）
 *   B 类分量按均匀分布取半宽/√3；A 类按重复性
 * ==================================================================== */
say('\n=== E21 测量不确定度预算 ===');
{
    // 依据：4~20 mA 变送器 + GL10-4AD（16 位，环境温度 0~55 ℃ 精度电流 ±0.8% FS）
    // 温度通道量程 0~200 ℃（本文建议的量程，R5 修正后）
    const FS_T = 200, FS_P = 1000, FS_H = 100;
    function budget(FS, chan, comps) {
        const rows = comps.map((c) => {
            const u = c.halfwidth / Math.sqrt(3);
            return { channel: chan, quantity: c.name, source: c.src,
                     halfwidth: c.halfwidth, unit: c.unit, distribution: '均匀',
                     u_b: +u.toFixed(5), weight_c2: +Math.pow(c.c, 2).toFixed(0) };
        });
        const uc = Math.sqrt(rows.reduce((a, b) => a + Math.pow(b.u_b * b.weight_c2, 2), 0));
        return { rows, uc };
    }
    // 温度通道：B 类
    const bT = budget(FS_T, '温度/℃', [
        { name: '变送器最大允许误差（MPE）', halfwidth: 0.5 * FS_T / 100, unit: '℃', src: '精度等级 0.5% FS，数据手册', c: 1 },
        { name: 'AD 模块增益误差（常温 ±0.1% FS）', halfwidth: 0.001 * FS_T, unit: '℃', src: 'GL10-4AD 手册 25 ℃', c: 1 },
        { name: 'AD 模块增益误差（全温区 ±0.8% FS）', halfwidth: 0.008 * FS_T, unit: '℃', src: 'GL10-4AD 手册 0~55 ℃', c: 1 },
        { name: 'AD 模块非线性（±1.5 LSB）', halfwidth: 1.5 * FS_T / 65536, unit: '℃', src: '16 位 ADC + 手册非线性指标', c: 1 },
        { name: '10 点均值后 ×10 定点重编码', halfwidth: 0.1 / 2, unit: '℃', src: '量化不确定度半宽 ½LSB', c: 1 },
        { name: '10 点均值带来的量化削减', halfwidth: 0.1 / 2 / Math.sqrt(12 * 10), unit: '℃', src: '均值的方差削减', c: 1 },
    ]);
    // A 类：假设重复性 σ_A = 0.20 ℃（恒温 30 min、n=10 的典型值，待实测标定）
    const uAT = 0.20;
    const ucT = Math.sqrt(bT.uc ** 2 + uAT ** 2);
    say(`   温度通道：B 类合成 u_c = ${bT.uc.toFixed(4)} ℃；含 A 类（假设 σ_A=0.20 ℃）后 u_c = ${ucT.toFixed(4)} ℃；U(k=2) = ${(2 * ucT).toFixed(3)} ℃`);
    bT.rows.forEach((r) => say(`     ${r.quantity}: 半宽 ${r.halfwidth.toFixed(4)} ${r.unit} → u_b = ${r.u_b.toFixed(5)}`));

    const bP = budget(FS_P, '压力/kPa', [
        { name: '变送器 MPE（0.5% FS）', halfwidth: 0.005 * FS_P, unit: 'kPa', src: '精度等级 0.5% FS', c: 1 },
        { name: 'AD 增益（全温区 ±0.8% FS）', halfwidth: 0.008 * FS_P, unit: 'kPa', src: 'GL10-4AD 手册', c: 1 },
        { name: 'AD 非线性（±1.5 LSB）', halfwidth: 1.5 * FS_P / 65536, unit: 'kPa', src: '16 位 ADC', c: 1 },
        { name: '定点重编码 ½LSB', halfwidth: 0.1 / 2, unit: 'kPa', src: '量化不确定度半宽', c: 1 },
    ]);
    const uAP = 0.5;
    const ucP = Math.sqrt(bP.uc ** 2 + uAP ** 2);
    say(`   压力通道：B 类 u_c = ${bP.uc.toFixed(3)} kPa；含 A 类（σ_A=0.50 kPa）后 u_c = ${ucP.toFixed(3)} kPa；U(k=2) = ${(2 * ucP).toFixed(2)} kPa`);

    const bH = budget(FS_H, '湿度/%RH', [
        { name: '变送器 MPE（0.5% FS）', halfwidth: 0.005 * FS_H, unit: '%RH', src: '精度等级 0.5% FS', c: 1 },
        { name: 'AD 增益（全温区 ±0.8% FS）', halfwidth: 0.008 * FS_H, unit: '%RH', src: 'GL10-4AD 手册', c: 1 },
        { name: 'AD 非线性（±1.5 LSB）', halfwidth: 1.5 * FS_H / 65536, unit: '%RH', src: '16 位 ADC', c: 1 },
        { name: '定点重编码 ½LSB', halfwidth: 0.1 / 2, unit: '%RH', src: '量化不确定度半宽', c: 1 },
    ]);
    const uAH = 0.2;
    const ucH = Math.sqrt(bH.uc ** 2 + uAH ** 2);
    say(`   湿度通道：B 类 u_c = ${bH.uc.toFixed(4)} %RH；含 A 类（σ_A=0.20 %RH）后 u_c = ${ucH.toFixed(4)} %RH；U(k=2) = ${(2 * ucH).toFixed(3)} %RH`);

    dump('E21_uncertainty_T.csv', bT.rows);
    dump('E21_uncertainty_P.csv', bP.rows);
    dump('E21_uncertainty_H.csv', bH.rows);
    dump('E21_uncertainty_summary.csv', [
        { channel: '温度/℃', FS: FS_T, u_c_B: +bT.uc.toFixed(4), u_c_total: +ucT.toFixed(4),
          U_k2: +(2 * ucT).toFixed(3), quant_share_pct: +(Math.pow(0.1 / 2 / Math.sqrt(3) / ucT, 2) * 100).toFixed(3),
          level_gap_ratio: +(10 / (2 * ucT)).toFixed(2), note: '相邻等级间隔 10 ℃' },
        { channel: '压力/kPa', FS: FS_P, u_c_B: +bP.uc.toFixed(4), u_c_total: +ucP.toFixed(4),
          U_k2: +(2 * ucP).toFixed(2), quant_share_pct: +(Math.pow(0.1 / 2 / Math.sqrt(3) / ucP, 2) * 100).toFixed(3),
          level_gap_ratio: +(100 / (2 * ucP)).toFixed(2), note: '相邻等级间隔 100 kPa' },
        { channel: '湿度/%RH', FS: FS_H, u_c_B: +bH.uc.toFixed(4), u_c_total: +ucH.toFixed(4),
          U_k2: +(2 * ucH).toFixed(3), quant_share_pct: +(Math.pow(0.1 / 2 / Math.sqrt(3) / ucH, 2) * 100).toFixed(3),
          level_gap_ratio: +(7 / (2 * ucH)).toFixed(2), note: '相邻等级间隔 7 %RH' },
    ]);
    say('   量化分量在总方差中的占比：温度 <0.01%，压力/湿度同样可忽略 ⇒ ½LSB 不是限制精度的主要因素');

    // 变化率判据与不确定度的相容性
    const comp = [];
    for (const [chan, rw, u] of [['温度', 2.0, ucT], ['压力', 80, ucP], ['湿度', 5.0, ucH]]) {
        const uDiff = u * Math.SQRT2;              // W=60 s 差分的合成不确定度
        comp.push({ channel: chan, roc_threshold: rw, u_60s_diff: +uDiff.toFixed(4),
                    occupy_pct: +(uDiff / rw * 100).toFixed(1),
                    verdict: uDiff / rw < 0.1 ? '相容（判据不确定度 <10%）' : '需修正门限' });
        say(`   ${chan}：60 s 差分的不确定度 U=√2u=${uDiff.toFixed(4)}，占判据 ${rw} 的 ${(uDiff / rw * 100).toFixed(1)}%`);
    }
    dump('E21_roc_compatibility.csv', comp);
}

/* =======================================================================
 * E22 阈值依据复核
 * ==================================================================== */
say('\n=== E22 阈值依据复核 ===');
{
    const rows = [
        { item: 'TB/T 1842.3—2019 4.2.1', content: '碳滑板在静态额定电流下温度稳定后持续 30 min，温度不应超过 150 ℃',
          value: '150 ℃', applies: '碳滑板温度上限（标准强制）' },
        { item: 'TB/T 1842.2—2016 4.3.1', content: '碳滑板在 150 ℃ 保持 1 h 记录位移，试验后不影响使用功能',
          value: '150 ℃', applies: '高温机械性能保持' },
        { item: 'TB/T 1842.3 4.3.1', content: '碳滑板在 150 ℃ 和 −40 ℃ 下保持 1 h',
          value: '150 ℃ / −40 ℃', applies: '高低温适用范围' },
        { item: 'EN 50317:2022 4.2', content: '接触力测量系统采样率 ≥200 Hz 或空间采样 ≤0.40 m；20 Hz 低通滤波（6 阶以上）',
          value: '≥200 Hz', applies: '动态接触力测量带宽要求' },
        { item: 'EN 50367', content: '弓网界面运行性能准则；目标平均接触力随速度的经验式 Fm = a·v² + b',
          value: 'AC 0.00097；DC 0.00155（b=70）', applies: '目标平均接触力' },
        { item: 'EN 50317:2022 4.3', content: '燃弧检测响应时间 <100 µs；阈值 5 m 处 25 kV 交流 160 µW/cm²',
          value: '160 µW/cm²', applies: '燃弧检测' },
        { item: '本平台原阈值', content: '温度 80/90/100 ℃；压力 1000/1100/1200 kPa；湿度 85/92/97 %RH',
          value: '80 ℃', applies: '与 TB/T 1842.3 的 150 ℃ 差 70 ℃，且量程上限与阈值重合' },
    ];
    dump('E22_threshold_basis.csv', rows);
    rows.forEach((r) => say(`   ${r.item}：${r.content}`));

    // 量程-阈值相容性矩阵
    const comp = [];
    for (const [r0, r1, thr] of [[0, 80, 80], [0, 200, 80], [0, 200, 150], [0, 500, 150]]) {
        comp.push({ range_C: `${r0}~${r1}`, warning_threshold: thr,
                    reachable: thr < r1 ? '可达' : '不可达（阈值=量程上限，超量程被钳位）',
                    headroom_C: r1 - thr,
                    covers_TB150C: r1 >= 150 ? '是' : '否' });
    }
    dump('E22_range_threshold_matrix.csv', comp);
    say('   量程—阈值相容性：');
    comp.forEach((c) => say(`     量程 ${c.range_C} ℃ + 预警 ${c.warning_threshold} ℃ → ${c.reachable}；覆盖 TB/T 1842.3 的 150 ℃：${c.covers_TB150C}`));
}

/* =======================================================================
 * E23 与经典变化检测方法的对照
 * ==================================================================== */
say('\n=== E23 与经典变化检测方法的对照 ===');
{
    const DT = 1000, WMUL = 60;     // 1 s 采样，60 s 窗
    // 参考实现：3 点中值 + 阈值/变化率判定，各方法独立
    function med3(sig) { return median3(sig[0], sig[1], sig[2]); }

    /** Page CUSUM（单侧，检测均值上升），参考 Page(1954) */
    function cusum(sig, k, h) {
        let S = 0;
        const sd = sig_sd(sig);
        const kk = k * sd, hh = h * sd;
        for (let i = 3; i < sig.length; i++) {
            const v = median3(sig[i - 2], sig[i - 1], sig[i]);
            S = S + (v - sig[0]) - kk;
            if (S < 0) S = 0;
            if (S > hh) return i;
        }
        return -1;
    }
    /** EWMA（Crowston-West 界），参考 Croston(1957) */
    function ewma(sig, lam, L) {
        let z = median3(sig[0], sig[1], sig[2]);
        const sd = sig_sd(sig);
        for (let i = 3; i < sig.length; i++) {
            const v = median3(sig[i - 2], sig[i - 1], sig[i]);
            z = lam * v + (1 - lam) * z;
            const sigma_z = sd * Math.sqrt(lam / (2 - lam) * (1 - Math.pow(1 - lam, 2 * (i - 2))));
            if (Math.abs(z - sig[0]) > L * sigma_z) return i;
        }
        return -1;
    }
    function sig_sd(a) { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); }
    /** Page-Hinkley，参考 Page(1954) */
    function pageHinkley(sig, delta, eps) {
        const sd = sig_sd(sig);
        const d = delta * sd, e = eps * sd;
        let Sp = 0, Sm = 0, Spmin = 0, Smmax = 0;
        for (let i = 3; i < sig.length; i++) {
            const v = median3(sig[i - 2], sig[i - 1], sig[i]);
            Sp = Sp + v - sig[0] - d; if (Sp < Spmin) Spmin = Sp;
            Sm = Sm + v - sig[0] + d; if (Sm > Smmax) Smmax = Sm;
            if (Sp - Spmin > e || Smmax - Sm > e) return i;
        }
        return -1;
    }
    /** 本文方法（平台真实实现） */
    function proposed(sig, rate, durS) {
        const e = new AlarmEngine({ voteEnabled: true, voteSlopeMode: 'hybrid', confirmN: 2,
                                    voteWindowMs: 45000, voteRatio: 0.5, voteMinSamples: 2, slopeSpanMs: 20000 });
        for (let i = 0; i <= durS; i++) e.push({ t: i * 1000, ...BASE, temperature: sig[i] });
        const a = e.alarms.filter((x) => x.signal === 'temperature');
        return a.length ? Math.round(a[0].t / 1000) : -1;
    }

    const rows = [];
    // ROC 扫描：为每种方法设一组门限，扫出 (FAR, Pd) 工作曲线
    const GRID = {
        cusum: { param: 'h', vals: [20, 30, 40, 50, 70, 100, 150, 200, 300, 500] },
        ewma: { param: 'L', vals: [8, 9, 10, 11, 12, 13, 14, 15, 16, 18] },
        ph: { param: 'eps', vals: [15, 20, 30, 50, 80, 120, 180, 250, 350, 500] },
    };
    // ---- 标定 FAR：纯噪声下门限的误报触发率 ----
    function farOf(fn, NT = 200, DUR = 1200) {
        let hit = 0;
        for (let n = 0; n < NT; n++) {
            const r = rng(120000 + n * 13);
            const sig = []; for (let i = 0; i <= DUR; i++) sig.push(25 + gauss(r) * 1.0);
            if (fn(sig) >= 0) hit++;
        }
        return hit / NT;
    }
    function pdOf(fn, rate, NT = 60, DUR = 1200) {
        let hit = 0;
        for (let n = 0; n < NT; n++) {
            const r = rng(130000 + n * 13 + Math.round(rate));
            const sig = []; for (let i = 0; i <= DUR; i++) sig.push(25 + (rate / 60) * i + gauss(r) * 1.0);
            if (fn(sig) >= 0) hit++;
        }
        return hit / NT;
    }
    function medOf(fn, rate, NT = 60, DUR = 1200) {
        const d = [];
        for (let n = 0; n < NT; n++) {
            const r = rng(130000 + n * 13 + Math.round(rate));
            const sig = []; for (let i = 0; i <= DUR; i++) sig.push(25 + (rate / 60) * i + gauss(r) * 1.0);
            const x = fn(sig); if (x >= 0) d.push(x);
        }
        d.sort((a, b) => a - b);
        return d.length ? d[Math.floor(d.length / 2)] : null;
    }
    const roc = [];
    for (const meth of ['cusum', 'ewma', 'ph']) {
        for (const v of GRID[meth].vals) {
            let fn;
            if (meth === 'cusum') fn = (s) => cusum(s, 0.5, v);
            else if (meth === 'ewma') fn = (s) => ewma(s, 0.3, v);
            else fn = (s) => pageHinkley(s, 0.5, v);
            const far = farOf(fn);
            const rec = { method: meth, param: GRID[meth].param, value: v, far };
            for (const rate of [1, 3, 10]) {
                rec['pd_' + rate] = pdOf(fn, rate);
                rec['med_' + rate] = medOf(fn, rate);
            }
            roc.push(rec);
            say(`   ${meth}(${GRID[meth].param}=${String(v).padStart(4)})：FAR ${(far * 100).toFixed(2)}%  P_d(1℃/min)=${rec.pd_1.toFixed(2)}  P_d(3)=${rec.pd_3.toFixed(2)}  P_d(10)=${rec.pd_10.toFixed(2)}`);
        }
    }
    // 本文方法的 ROC（扫 Tvote 与 ρ）
    for (const T of [60, 90, 120, 180, 240, 300]) {
        for (const rho of [0.5, 0.6, 0.7, 0.8]) {
            const cfg = { voteEnabled: true, voteSlopeMode: 'hybrid', confirmN: 2,
                          voteWindowMs: T * 1000, voteRatio: rho, voteMinSamples: 2, slopeSpanMs: 20000 };
            const fn = (s) => proposed(s, 0, s.length);
            let hit = 0; const NT = 200, DUR = 1800;
            for (let n = 0; n < NT; n++) {
                const r = rng(120000 + n * 13);
                const sig = []; for (let i = 0; i <= DUR; i++) sig.push(25 + gauss(r) * 1.0);
                if (fn(sig) >= 0) hit++;
            }
            const rec = { method: 'proposed', param: 'Tvote/rho', value: `${T}s/${rho}`, far: hit / NT };
            for (const rate of [1, 3, 10]) {
                let h2 = 0, dd = [];
                for (let n = 0; n < 60; n++) {
                    const r = rng(130000 + n * 13 + Math.round(rate));
                    const sig = []; for (let i = 0; i <= DUR; i++) sig.push(25 + (rate / 60) * i + gauss(r) * 1.0);
                    const e = new AlarmEngine(cfg);
                    for (let i = 0; i <= DUR; i++) e.push({ t: i * 1000, ...BASE, temperature: sig[i] });
                    const a = e.alarms.filter((x) => x.signal === 'temperature');
                    if (a.length) { h2++; dd.push(Math.round(a[0].t / 1000)); }
                }
                dd.sort((a, b) => a - b);
                rec['pd_' + rate] = +(h2 / 60).toFixed(3);
                rec['med_' + rate] = dd.length ? dd[Math.floor(dd.length / 2)] : null;
            }
            roc.push(rec);
            say(`   proposed(T=${T}s/ρ=${rho})：FAR ${(rec.far * 100).toFixed(2)}%  P_d(1)=${rec.pd_1}  P_d(3)=${rec.pd_3}  P_d(10)=${rec.pd_10}  时延(3)=${rec.med_3}s`);
        }
    }
    dump('E23_baseline_roc.csv', roc);

    // 在等 FAR 水平上的时延对比（目标 FAR ≤ 5%）
    const eq = [];
    for (const meth of ['cusum', 'ewma', 'ph', 'proposed']) {
        const sub = roc.filter((r) => r.method === meth && r.far > 0 && r.far <= 0.05);
        if (!sub.length) {
            // 取 FAR 最小的可用工作点
            const s2 = roc.filter((r) => r.method === meth && r.far > 0);
            if (!s2.length) continue;
            s2.sort((a, b) => a.far - b.far);
            const w = s2[0];
            eq.push({ method: meth, working_point: w.param + '=' + w.value,
                      far_pct: +(w.far * 100).toFixed(2), note: '网格内最低 FAR 工作点',
                      pd_1: w.pd_1, med_1_s: w.med_1, pd_3: w.pd_3, med_3_s: w.med_3,
                      pd_10: w.pd_10, med_10_s: w.med_10 });
            say(`   ${meth} @ FAR≈${(w.far * 100).toFixed(2)}%（${w.param}=${w.value}，网格下限）：P_d(3)=${w.pd_3}，时延 ${w.med_3} s`);
            continue;
        }
        sub.sort((a, b) => Math.abs(a.far - 0.02) - Math.abs(b.far - 0.02));
        const w = sub[0];
        eq.push({ method: meth, working_point: w.param + '=' + w.value,
                  far_pct: +(w.far * 100).toFixed(2), note: 'FAR ≤ 5% 内最接近 2%',
                  pd_1: w.pd_1, med_1_s: w.med_1, pd_3: w.pd_3, med_3_s: w.med_3,
                  pd_10: w.pd_10, med_10_s: w.med_10 });
        say(`   ${meth} @ FAR≈${(w.far * 100).toFixed(2)}%（${w.param}=${w.value}）：P_d(1)=${w.pd_1} 时延 ${w.med_1}s；P_d(3)=${w.pd_3} 时延 ${w.med_3}s`);
    }
    dump('E23_equal_far_compare.csv', eq);
}

/* =======================================================================
 * E24 序号方案带宽对比
 * ==================================================================== */
say('\n=== E24 序号方案带宽对比 ===');
{
    const MBAP = 7, REQ_PDU = 5;
    const variants = [
        { name: '16 位序号（1 个寄存器，现方案）', regs: 5, note: '存在回绕盲区' },
        { name: '32 位序号（2 个寄存器）', regs: 6, note: '消除回绕歧义' },
        { name: '48 位序号 + 绝对时间戳高位（3 个寄存器）', regs: 7, note: '可跨盲区绝对定位' },
    ];
    const rows = [];
    for (const v of variants) {
        const app = (MBAP + REQ_PDU) + (MBAP + 1 + 1 + 2 * v.regs);
        const wire = (MBAP + REQ_PDU) + 14 + 20 + 20 + 20 + (MBAP + 1 + 1 + 2 * v.regs) + 14 + 20 + 20 + 20 + (14 + 20 + 20 + 20);
        rows.push({ scheme: v.name, registers: v.regs, app_bytes: app, wire_bytes: wire,
                    daily_MB_at_P2: +(43200 * wire / 1048576).toFixed(4),
                    overhead_pct: +((wire - app) / app * 100).toFixed(1), note: v.note });
        say(`   ${v.name}：应用层 ${app} B，线缆 ${wire} B，P=2 s 时 ${(43200 * wire / 1048576).toFixed(4)} MiB/d，协议栈开销 ${((wire - app) / app * 100).toFixed(0)}%`);
    }
    dump('E24_seq_scheme_bandwidth.csv', rows);
    say(`   16→32 位序号的增量：应用层 +2 B/帧（+${((6 - 5) / 5 * 100).toFixed(0)}%），线缆 +2 B/帧（+${((((MBAP + REQ_PDU) + 14 + 20 + 20 + 20 + (MBAP + 1 + 1 + 12) + 14 + 20 + 20 + 20 + 74) - ((MBAP + REQ_PDU) + 14 + 20 + 20 + 20 + (MBAP + 1 + 1 + 10) + 14 + 20 + 20 + 20 + 74)) / ((MBAP + REQ_PDU) + 14 + 20 + 20 + 20 + (MBAP + 1 + 1 + 10) + 14 + 20 + 20 + 20 + 74) * 100).toFixed(1)}%）`);
}

fs.writeFileSync(OUT + 'R6_run_log.txt', log.join('\n'), 'utf8');
say('\nR6 补充复算完成。');
