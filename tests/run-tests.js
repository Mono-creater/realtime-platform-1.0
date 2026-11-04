/**
 * tests/run-tests.js —— 升级效果检验（无第三方依赖，node tests/run-tests.js 直接运行）
 *
 * 覆盖：标准公式、控制器 v1/v2 对比（含 IMC 补全）、告警时延与误报抑制、
 *       链路质量与写回读校验、运维工单与健康分级。
 * 输出：控制台 PASS/FAIL + tests/report.json 指标汇总。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const std = require('../standards');
const ctl = require('../control-engine-v2');
const { AlarmEngine } = require('../alarm-engine');
const { LinkMonitor } = require('../link-monitor');
const { MaintenanceService } = require('../maintenance');

let pass = 0, fail = 0;
const lines = [];
const report = { sections: {} };
function ok(cond, name, extra) {
    if (cond) { pass++; lines.push(`PASS  ${name}${extra ? '  ' + extra : ''}`); }
    else { fail++; lines.push(`FAIL  ${name}${extra ? '  ' + extra : ''}`); }
}
function near(a, b, tol, name) { ok(Math.abs(a - b) <= tol, name, `(${a} ≈ ${b} ±${tol})`); }
function section(t) { lines.push(''); lines.push('== ' + t + ' =='); }

/* ---------------- A. 标准与公式 ---------------- */
section('A 标准与指标公式');
const f0 = std.targetMeanContactForce(0), f80 = std.targetMeanContactForce(80),
      f160 = std.targetMeanContactForce(160), f250 = std.targetMeanContactForce(250),
      fd80 = std.targetMeanContactForce(80, { system: 'DC' });
near(f0.value, 70, 0.01, '交流 v=0 时 Fm=70 N');
near(f80.value, 0.00097 * 6400 + 70, 0.01, '交流 v=80 km/h 的目标接触力符合 Fm=0.00097v²+70');
near(f160.value, 0.00097 * 25600 + 70, 0.01, '交流 v=160 km/h 目标接触力');
near(fd80.value, 0.00155 * 6400 + 70, 0.01, '直流 v=80 km/h 目标接触力（系数 0.00155）');
ok(f250.value <= 250, '目标值受上限截断（≤250 N）', `Fm(250)=${f250.value.toFixed(1)} N`);
const lim = std.dynamicLimits(f160.value);
near(lim.sigmaMax, 0.3 * f160.value, 0.01, '标准差限值 σ≤0.3Fm');
near(lim.fMax, f160.value + 3 * lim.sigmaMax, 0.01, '上限 Fmax=Fm+3σ');
const eGood = std.evaluateContactForce({ v: 80, mean: f80.value, std: 0.1 * f80.value });
const eBad = std.evaluateContactForce({ v: 80, mean: f80.value * 2, std: 0.5 * f80.value });
ok(eGood.ok === true, '接触力一致性：正常样本通过');
ok(eBad.ok === false && eBad.violations.length === 2, '接触力一致性：越限样本报出 2 项违规', eBad.violations.join('；'));
report.sections.standards = { Fm_0: f0.value, Fm_80: f80.value, Fm_160: +f160.value.toFixed(2), Fm_250: f250.value, DC_80: +fd80.value.toFixed(2), limits: lim };

/* ---------------- B. 控制器 v1 / v2 对比 ---------------- */
section('B 双环 PID 控制升级（接触力环：升阶跃 70→100 N）');
const plant = { gain: 0.9923, K: 0.9923, T: 1.7046, L: 1.0078, tau: 1.7046, dt: 0.5, target: 100, y0: 70, u0: 70, ticks: 200, uMin: 50, uMax: 1000 };
const zn = ctl.znGains(plant.K, plant.T, plant.L);
const safe = ctl.tuneSafe(plant.K, plant.T, plant.L);
const conservative = { kp: 1.5, ki: 0.5, kd: 0.5 };              // 项目出厂默认（保守）
const P = ctl.PRESETS.contactForce;
const rCons = ctl.simulateClosedLoop(Object.assign({}, plant, { gains: conservative, derivFilterN: 0, integralSeparation: 1e9, rampRate: 0 }));
const rZN = ctl.simulateClosedLoop(Object.assign({}, plant, { gains: zn, derivFilterN: 0, integralSeparation: 1e9, rampRate: 0 }));
const rV2 = ctl.simulateClosedLoop(Object.assign({}, plant, { gains: safe, derivFilterN: P.derivFilterN, integralSeparation: P.integralSeparation, rampRate: P.rampRate }));
ok(rZN.metrics.overshootPct > 50, 'v1 直接套用 Z-N 超调过大（暴露整定风险）', `overshoot=${rZN.metrics.overshootPct}%`);
ok(rV2.metrics.overshootPct <= 5, 'v2 安全预设超调 ≤5%', `overshoot=${rV2.metrics.overshootPct}%（Z-N ${rZN.metrics.overshootPct}%，出厂保守 ${rCons.metrics.overshootPct}%）`);
ok(rV2.metrics.settleS <= 20 && Math.abs(rV2.metrics.sse) <= 0.5, 'v2 在 20 s 内稳定且稳态偏差 ≤0.5 N',
   `settle=${rV2.metrics.settleS} s, sse=${rV2.metrics.sse} N`);
ok(rV2.metrics.overshootPct < rCons.metrics.overshootPct, 'v2 超调优于出厂保守参数（同为无扰投入）',
   `${rCons.metrics.overshootPct}% → ${rV2.metrics.overshootPct}%`);
ok(safe.ok && safe.method === 'ZN-折减', '安全整定策略：T>L 时按纯滞后占比折减 Z-N 增益', safe.reason);
report.sections.controlForce = { zn, safe: { reduce: safe.reduce, kp: safe.kp, ki: safe.ki, kd: safe.kd, method: safe.method },
    preset: P, conservative: rCons.metrics, znBase: rZN.metrics, v2Safe: rV2.metrics };

section('B2 姿态环：Z-N 不适用 → IMC 补全');
const pos = { gain: 1.0, K: 1.0, T: 0.5, L: 0.6, tau: 0.5, dt: 0.5, target: 2400, y0: 1800, u0: 1800, ticks: 200, uMin: 1000, uMax: 2600 };
const safeP = ctl.tuneSafe(pos.K, pos.T, pos.L);
const PP = ctl.PRESETS.posture;
ok(pos.T <= pos.L, '姿态通道 T≤L：Z-N 开环整定在原理上不适用', `T=${pos.T} s, L=${pos.L} s`);
ok(safeP.method === 'IMC', '安全整定策略自动切换为 IMC-PI', safeP.reason);
const rImcP = ctl.simulateClosedLoop(Object.assign({}, pos, { gains: safeP, derivFilterN: PP.derivFilterN, integralSeparation: PP.integralSeparation, rampRate: PP.rampRate }));
ok(rImcP.metrics.overshootPct <= 5, 'IMC 预设下姿态环超调 ≤5%', `overshoot=${rImcP.metrics.overshootPct}%`);
ok(rImcP.metrics.settleS <= 30 && Math.abs(rImcP.metrics.sse) <= 2, 'IMC 预设下姿态环 30 s 内稳定且偏差 ≤2 mm',
   `settle=${rImcP.metrics.settleS} s, sse=${rImcP.metrics.sse} mm`);
report.sections.controlPosture = { safe: safeP, preset: PP, imcMetrics: rImcP.metrics };

/* ---------------- C. 告警：误报抑制与缓变早发现（论文 §2.4 / §4.4 口径） ----------------
 * 1.0 变更：变化率通道由"时间窗持续性投票"改为"EWMA 趋势检测"（论文根治方案）。
 *   · 滤波链统一为 3 点中值 → EWMA（λ=0.2），阈值通道与变化率通道共用同一序列；
 *   · 变化率取 EWMA 序列在窗口 W 上的差分（式5），窗口与轮询周期解耦；
 *   · 误报率由式(6)(12) 解析校核（δmin = 3σr ≤ rw），不再凭经验试凑。
 * 原 `medianOnly` / `avgWindow` 选项已随投票方案一并移除，故本组用例按新口径重写。
 */
section('C 告警引擎：抑制误报 + 缓变早发现（EWMA 趋势检测）');

// C1 单点尖峰误报抑制：原始阈值判据会误报，本文方法不误报
const RAW = { tempHigh: 80, tempLow: -10, pressHigh: 1000, pressLow: 100, humidHigh: 85 };
let rawAlarms = 0;
{
    let over = 0;
    for (let i = 0; i < 10; i++) {
        const v = i === 5 ? 95 : 25;
        over = v > RAW.tempHigh ? over + 1 : 0;
        if (over >= 1) rawAlarms += 1;
    }
}
const eng = new AlarmEngine({ confirmN: 2, suppressMs: 0 });
let v2Alarms = 0;
for (let i = 0; i < 10; i++) {
    const t = i * 1000;
    const spike = i === 5 ? 95 : 25;
    v2Alarms += eng.push({ t, temperature: spike }).length;
}
ok(rawAlarms === 1, '原始阈值判据对单点尖峰产生 1 次误报', `alarms=${rawAlarms}`);
ok(v2Alarms === 0, '本文方法（中值＋EWMA＋连续确认）抑制单点尖峰误报', `alarms=${v2Alarms}`);

// C2 阶跃越限：阈值通道须在有限时间内独立成立（不因变化率通道门控而延迟）
function stepCase(engine, onset, value, ticks) {
    let lat = null;
    for (let i = 0; i < ticks; i++) {
        const t = i * 1000;
        const v = t >= onset ? value : 25;
        const a = engine.push({ t, temperature: v, truthOnsetMs: onset });
        if (a.length && lat === null) lat = a[0].latencyMs;
    }
    return lat;
}
const latV2 = stepCase(new AlarmEngine({ confirmN: 2 }), 60000, 100, 200);
// 阶跃至 100 ℃（越过 critical 级 100 ℃ 上限）：EWMA 收敛 + n 点确认，应在数十秒内成立
ok(latV2 !== null && latV2 <= 30000,
   '阶跃越限由阈值通道独立成立，时延受 EWMA 平滑与连续确认约束（≤30 s）',
   `latency=${latV2} ms`);

// C3 缓变（3 ℃/min）：EWMA 趋势检测显著早于纯阈值判据
function rampCase(engine, ticks) {
    let lat = null;
    for (let i = 0; i < ticks; i++) {
        const t = i * 1000;
        const v = 25 + 0.05 * i;              // 0.05 ℃/s = 3 ℃/min
        const a = engine.push({ t, temperature: v, truthOnsetMs: 0 });
        if (a.length && lat === null) lat = a[0].latencyMs;
    }
    return lat;
}
const rampV2 = rampCase(new AlarmEngine({ confirmN: 2 }), 3600);
const rampThresholdS = (80 - 25) / 3 * 60 + 3;          // 纯阈值判据 1 103 s
ok(rampV2 !== null && rampV2 / 1000 <= 120,
   'EWMA 趋势检测对 3 ℃/min 缓变的发现时延 ≈ W + 确认步（论文 61 s）',
   `v2=${(rampV2 / 1000).toFixed(0)} s vs 纯阈值 ${rampThresholdS} s`);

// C4 EWMA 解析式自检（式(6)/式(12)）：σr ≈ 0.4714、δmin ≈ 1.41、噪声边界 1.41（σ=1.0、λ=0.2、W=1 min）
const ewmaTrend = require('../ewma-trend.js');
const sr = ewmaTrend.sigmaRoc(1.0, 0.2, 1.0);
const dm = ewmaTrend.deltaMin(1.0, 0.2, 1.0);
const smax = ewmaTrend.sigmaMax(2.0, 0.2, 1.0);
ok(Math.abs(sr - 0.4714) < 0.002, '式(6) σr 解析值 ≈ 0.4714 ℃·min⁻¹（σ=1.0、λ=0.2、W=1 min，不含 σeff）', `σr=${sr.toFixed(4)}`);
ok(Math.abs(dm - 1.41) < 0.01, '式(12) δmin = 3σr ≈ 1.41 ℃·min⁻¹', `δmin=${dm.toFixed(4)}`);
ok(Math.abs(smax - 1.41) < 0.02, '由 δmin ≤ rw 反解噪声边界 σ ≤ 1.41 ℃（rw=2 ℃·min⁻¹）', `σmax=${smax.toFixed(3)}`);

// C4b λ 敏感性扫描的公式列（论文表12：σr/δmin 为解析值，平台可复现；
//      误报率列与发现时延列为论文侧脚本产物，D:/驭弓大师/10_创新升级/ 未归档，待收录）
for (const [l, expSr, expDm] of [[0.1, 0.324, 0.97], [0.2, 0.471, 1.41], [0.4, 0.707, 2.12], [0.5, 0.817, 2.45]]) {
    const s = ewmaTrend.sigmaRoc(1.0, l, 1.0);
    ok(Math.abs(s - expSr) < 0.01, `表12 λ=${l} 时 σr ≈ ${expSr} ℃·min⁻¹`, `σr=${s.toFixed(3)}`);
    const d = ewmaTrend.deltaMin(1.0, l, 1.0);
    ok(Math.abs(d - expDm) < 0.02, `表12 λ=${l} 时 δmin ≈ ${expDm} ℃·min⁻¹`, `δmin=${d.toFixed(3)}`);
}

// C5 噪声边界行为：σ=1.0 零误报；σ=2.5 判据不可分辨（应报噪声明）
{
    const e1 = new AlarmEngine({ sigma: 1.0, confirmN: 2, suppressMs: 0 });
    let n1 = 0;
    for (let i = 0; i < 3000; i++) n1 += e1.push({ t: i * 1000, temperature: 25 }).length;
    const e2 = new AlarmEngine({ sigma: 2.5, confirmN: 2, suppressMs: 0 });
    e2.push({ t: 0, temperature: 25 });
    ok(n1 === 0, 'σ=1.0 ℃ 常数输入零误报', `alarms=${n1}`);
    ok(e2.noiseWarnings.length > 0, 'σ=2.5 ℃ 超噪声边界时输出判据不可分辨告警（论文 §4.4）',
       `warnings=${e2.noiseWarnings.length}`);
}
report.sections.alarm = {
    spikeFalseAlarm: { raw: rawAlarms, v2: v2Alarms },
    stepLatencyMs: { v2: latV2 },
    rampLatencyMs: { v2: rampV2, thresholdS: rampThresholdS },
    ewmaAnalytics: { sigmaRoc: +sr.toFixed(4), deltaMin: +dm.toFixed(4), sigmaMax: +smax.toFixed(3) },
};

/* ---------------- D. 链路质量与写回读校验 ---------------- */
section('D 链路质量与写回读校验');
const lm = new LinkMonitor({ staleMs: 3000, badMs: 10000 });
let seq = 100;
for (let i = 0; i < 100; i++) {
    seq = (seq + 1) % 65536;
    if (i === 20 || i === 40 || i === 61) seq = (seq + 1) % 65536;   // 制造 3 处缺口
    lm.onPacket({ t: i * 1000, seq });
}
const ls = lm.stats(99000);
ok(ls.gaps === 3, '序号缺口统计正确（3 处）', `gaps=${ls.gaps}`);
near(ls.lossRate, 3 / 103, 0.01, '丢包率与缺口/应到包数一致');
ok(lm.quality(100000) === 'GOOD', '新鲜数据质量码 GOOD');
ok(lm.quality(103500) === 'STALE', '超 stale 阈值质量码 STALE');
ok(lm.quality(112000) === 'BAD', '超 bad 阈值质量码 BAD');
lm.onError(); const d1 = lm.nextRetryDelay(); lm.onError(); const d2 = lm.nextRetryDelay(); lm.onError(); const d3 = lm.nextRetryDelay();
ok(d1 < d2 && d2 < d3 && d3 <= 8000 * 1.1, '重连退避递增且有上限', `${d1}, ${d2}, ${d3} ms`);
(async () => {
    const wOk = await lm.writeVerify({ write: async () => {}, read: async () => 100, reg: 2021, value: 100 });
    ok(wOk.ok === true && wOk.attempts === 1, '写回读校验：一致时通过');
    const wBad = await lm.writeVerify({ write: async () => {}, read: async () => 50, reg: 2022, value: 2400, retries: 2 });
    ok(wBad.ok === false && wBad.attempts === 3, '写回读校验：不一致时重试并判失败', wBad.error);
    report.sections.link = { stats: ls, backoff: [d1, d2, d3], writeVerify: { ok: wOk, bad: { ok: wBad.ok, attempts: wBad.attempts } } };

    /* ---------------- E. 运维闭环 ---------------- */
    section('E 工单闭环、健康分级与 KPI');
    const ms = new MaintenanceService();
    const o = ms.create({ deviceId: 'PANTO-01', level: 'major', description: '接触力偏高', at: 0 });
    ok(ms.start(o.id, 'w1', 1000).ok === false, '状态机：未指派不能直接开工');
    ok(ms.assign(o.id, 'w1', 1000).ok && ms.start(o.id, 'w1', 2000).ok && ms.complete(o.id, 'w1', 62000, '复紧气路').ok && ms.verify(o.id, 'w2', 122000, '复核通过').ok, '工单走完 指派→开工→完成→复核');
    ok(ms.auditTrail(o.id).length === 5, '审计轨迹完整（创建＋4 次流转）', `entries=${ms.auditTrail(o.id).length}`);
    near(ms.mttr(), 1.0, 0.05, 'MTTR 计算正确（1 min）');
    const h1 = ms.healthIndex({ forceMean: 100, forceTarget: 100, forceStd: 2, tempMax: 60, alarmCount24h: 0 });
    const h2 = ms.healthIndex({ forceMean: 130, forceTarget: 100, forceStd: 20, tempMax: 88, alarmCount24h: 12 });
    ok(h1.grade === '正常' && h2.score < h1.score, '健康指数：正常状态高分、异常状态降级', `${h1.score}(${h1.grade}) vs ${h2.score}(${h2.grade})`);
    const alarm = { id: 1, level: 'critical', message: '接触力越限' };
    const wo = ms.createFromAlarm(alarm, 'PANTO-02', 200000);
    ok(wo.level === 'critical', '由严重告警自动生成同等级工单');
    report.sections.maintenance = { mttr: ms.mttr(), health: { normal: h1, abnormal: h2 }, auditEntries: ms.auditTrail(o.id).length };

    /* ---------------- F. 写接口安全加固 ---------------- */
    section('F 写接口安全加固（令牌/限流/审计/上传白名单/增益上限）');
    const security = require('../security');

    function mockRes() {
        const res = {
            statusCode: 200, headers: {}, body: null, _finished: false,
            setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this._emitFinish(); return this; },
            _handlers: {},
            on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); return this; },
            _emitFinish() {
                if (this._finished) return; // 与 Express 一致：finish 只触发一次
                this._finished = true;
                (this._handlers.finish || []).forEach((fn) => fn());
            }
        };
        return res;
    }
    function mockReq(method, path, headers) {
        return { method, url: path, originalUrl: path, headers: headers || {}, ip: '10.0.0.9', socket: {} };
    }
    function run(mw, method, path, headers) {
        const req = mockReq(method, path, headers);
        const res = mockRes();
        let passed = false;
        mw(req, res, () => { passed = true; });
        if (passed) res._emitFinish(); // 模拟路由处理器返回、响应结束
        return { req, res, passed };
    }

    // F1 令牌校验：未启用时放行，启用后无令牌 401、带令牌放行
    const secOpen = security.createSecurity({ token: '' });
    ok(run(secOpen.middleware(), 'POST', '/api/control/auto').passed === true, '未配置 API_TOKEN 时写接口保持放行（不破坏现网）');
    const secTok = security.createSecurity({ token: 'S3cret-Token' });
    const r401 = run(secTok.middleware(), 'POST', '/api/control/auto');
    ok(r401.res.statusCode === 401 && r401.passed === false, '启用令牌后：无令牌写请求被拒 401');
    ok(run(secTok.middleware(), 'POST', '/api/control/auto', { 'x-api-token': 'S3cret-Token' }).passed === true, '携带 X-API-Token 正确令牌后放行');
    ok(run(secTok.middleware(), 'DELETE', '/api/warnings', { authorization: 'Bearer S3cret-Token' }).passed === true, 'Authorization: Bearer 形式同样识别');
    ok(run(secTok.middleware(), 'POST', '/api/control/auto', { 'x-api-token': 'wrong' }).res.statusCode === 401, '错误令牌被拒 401');
    ok(run(secTok.middleware(), 'GET', '/api/history').passed === true, '只读 GET 不受令牌与限流影响');

    // F2 频率限制：容量 3/min 时第 4 次写请求 429
    const secRl = security.createSecurity({ token: '', ratePerMin: 3 });
    const mwRl = secRl.middleware();
    const codes = [1, 2, 3, 4].map(() => run(mwRl, 'POST', '/api/alert').res.statusCode);
    ok(codes.slice(0, 3).every((c) => c === 200) && codes[3] === 429, '令牌桶限流：超出配额返回 429', `序列 ${codes.join(',')}`);
    const res429 = run(mwRl, 'POST', '/api/alert').res;
    ok(Number(res429.headers['retry-after']) > 0, '429 响应带 Retry-After 头', `Retry-After=${res429.headers['retry-after']} s`);

    // F3 审计：写操作留痕、只读不留痕
    const secAudit = security.createSecurity({ token: '', ratePerMin: 100 });
    const mwAudit = secAudit.middleware();
    run(mwAudit, 'POST', '/api/control/auto');
    run(mwAudit, 'POST', '/api/control/tune');
    run(mwAudit, 'GET', '/api/plc/packet');
    const stAudit = secAudit.status();
    ok(stAudit.auditCount === 2, '审计只记录写操作（2 次写、1 次读 → 2 条）', `count=${stAudit.auditCount}`);

    // F4 上传白名单
    const secUp = security.createSecurity({});
    const filt = secUp.uploadFilter();
    let upOk = null, upBad = null;
    filt({}, { originalname: 'photo.JPG' }, (e, v) => { upOk = e || v; });
    filt({}, { originalname: 'evil.html' }, (e, v) => { upBad = e || v; });
    ok(upOk === true, '上传白名单：.JPG 放行（大小写不敏感）');
    ok(upBad instanceof Error, '上传白名单：.html 被拒', upBad && upBad.message);
    let upSvg = null;
    filt({}, { originalname: 'x.svg' }, (e, v) => { upSvg = e || v; });
    ok(upSvg instanceof Error, '上传白名单：.svg 被拒（防脚本注入）');

    // F5 控制增益上限
    const eng = require('../control-engine').createControlEngine();
    ok(eng.setParams('force', { kp: 1e6 }).ok === false, 'PID 增益上限：kp=1e6 被拒');
    ok(eng.setParams('force', { kp: 2.4, ki: 1.2, kd: 1.2 }).ok === true, '正常工程参数仍可下发（kp=2.4）');
    ok(eng.setParams('force', { target: 99999 }).ok === false, '目标值超可实现范围仍被拒');

    report.sections.security = {
        tokenGuard: { disabledPass: true, unauthorized401: true, bearerOk: true, wrongToken401: true },
        rateLimit: { codes, retryAfterHeader: res429.headers['retry-after'] },
        audit: stAudit,
        upload: { jpg: 'allow', html: 'deny', svg: 'deny' },
        gainLimit: { reject1e6: true, acceptNormal: true }
    };

    /* ---------------- G. 1.0 新增能力（论文协议/链路/运维口径复现） ---------------- */
    section('G 1.0 新增能力：双包协议 / 序号回绕 / Wilson / 自适应变周期 / RUL');
    const plcPacket = require('../plc-packet.js');
    const { LinkMonitor: LM, SEQ_MAX } = require('../link-monitor.js');
    const { AdaptivePeriodController, adaptiveBandwidth, fixedBandwidth } = require('../adaptive-period.js');
    const { RULPredictor, linreg } = require('../rul-predictor.js');

    // G1 双包协议事务字节：FC03 请求 12 B + 响应 19 B = 31 B；异常周期追读子包再 +31 B
    const txNormal = 12 + 19;
    const txAnomaly = txNormal * 2;
    ok(txNormal === 31, '正常事务 31 B（FC03 请求 12 B + 响应 19 B）', `tx=${txNormal} B`);
    ok(txAnomaly === 62, '异常周期事务 62 B（含子包追读）', `tx=${txAnomaly} B`);
    // 日流量：2 s 轮询、异常率 0 → 1.339 MB/d（SI 制 1 MB = 10⁶ B，论文 §4.2）
    const dailyMB = (t) => t * (86400 / 2) / 1e6;
    ok(Math.abs(dailyMB(31) - 1.339) < 0.001, '2 s 轮询日流量 1.339 MB/d（异常率 0）', `${dailyMB(31).toFixed(3)} MB/d`);
    ok(Math.abs(dailyMB(62) - 2.678) < 0.001, '2 s 轮询日流量 2.678 MB/d（异常率 100%）', `${dailyMB(62).toFixed(3)} MB/d`);
    // 双基线压缩（论文 §4.2）：① 16 位逐样本 27 B/事务 @0.1 s → 23.33 MB/d → 17.4 倍；
    // ② 100 Hz 全量波形 33 B/事务 @0.01 s → 285.1 MB/d → 212.9 倍
    const base1 = fixedBandwidth(0.1, 27), base2 = fixedBandwidth(0.01, 33);
    ok(Math.abs(base1 - 23.33) < 0.01, '基线① 16 位逐样本（27 B @0.1 s）23.33 MB/d', `${base1.toFixed(3)} MB/d`);
    ok(Math.abs(base2 - 285.1) < 0.1, '基线② 100 Hz 全量波形（33 B @0.01 s）285.1 MB/d', `${base2.toFixed(2)} MB/d`);
    ok(Math.abs(base1 / dailyMB(31) - 17.42) < 0.05, '相对基线①压缩 17.4 倍', `${(base1 / dailyMB(31)).toFixed(2)}×`);
    ok(Math.abs(base2 / dailyMB(31) - 212.9) < 0.2, '相对基线②压缩 212.9 倍', `${(base2 / dailyMB(31)).toFixed(2)}×`);
    ok(Math.abs(base1 / dailyMB(62) - 8.71) < 0.05, '满异常相对基线①压缩 8.7 倍', `${(base1 / dailyMB(62)).toFixed(2)}×`);
    ok(Math.abs(base2 / dailyMB(62) - 106.5) < 0.2, '满异常相对基线②压缩 106.5 倍', `${(base2 / dailyMB(62)).toFixed(2)}×`);
    // 平均码率（论文 §4.2）
    ok(Math.abs(dailyMB(31) * 1e6 * 8 / 86400 / 1000 - 0.124) < 0.002, '正常码率 0.124 kbit/s', `${(dailyMB(31) * 1e6 * 8 / 86400 / 1000).toFixed(3)} kbit/s`);
    ok(Math.abs(base1 * 1e6 * 8 / 86400 / 1000 - 2.16) < 0.01, '基线①码率 2.16 kbit/s（16 位逐样本 27 B @0.1 s）', `${(base1 * 1e6 * 8 / 86400 / 1000).toFixed(2)} kbit/s`);

    // G2 寄存器映射与状态字（表2）
    ok(plcPacket.STATUS_BITS.extended === 0x40, '状态字 bit6 = 0x40 扩展协议标志', `bit6=${plcPacket.STATUS_BITS.extended.toString(16)}`);
    ok(plcPacket.STATUS_BITS.subValid === 0x80, '状态字 bit7 = 0x80 子包有效', `bit7=${plcPacket.STATUS_BITS.subValid.toString(16)}`);
    const mp = plcPacket.parseMainPacket([250, 9000, 500, 0x40 | 0x01, 1234]);
    ok(Math.abs(mp.temperature - 25) < 1e-9 && mp.extended === true && mp.anomalyBitmap === 1,
       '主包解析：温度 ×10 还原、扩展协议判定、异常位图提取', `T=${mp.temperature} ext=${mp.extended} bmp=${mp.anomalyBitmap}`);
    const sp = plcPacket.parseSubPacket([1234, 0b010, 0, 8000, 0]);
    const an = plcPacket.anomaliesFromBitmap(sp.bitmap, sp.values);
    ok(an.length === 1 && an[0].level === 'error', '子包位图 0b010 → 1 条 error 级低压报警', JSON.stringify(an.map((x) => [x.type, x.level])));

    // G3 序号回绕感知判据（论文表8 序号边界用例）
    const mkSeq = (seqs) => { const lm = new LM(); let t = 0; for (const s of seqs) lm.onPacket({ t: (t += 1000), seq: s }); return lm; };
    const wrapCycle = mkSeq(Array.from({ length: SEQ_MAX }, (_, i) => i + 1).concat([1]));
    ok(wrapCycle.gaps === 0, '完整回绕周期 65 535 帧零丢包 → 0 缺口（修正前为 1）', `gaps=${wrapCycle.gaps} wraps=${wrapCycle.wraps}`);
    const crossWrap = mkSeq([65531, 65532, 65533, 65534, 65535, 1, 2, 3, 4]);
    ok(crossWrap.gaps === 0, '跨越回绕边界零丢包 → 0 缺口（修正前为 1，丢包率 11.11%）', `gaps=${crossWrap.gaps}`);
    const boundaryLoss = mkSeq([65533, 65534, 65535, 2, 3, 4]);
    ok(boundaryLoss.gaps === 2, '回绕边界处丢 1 帧 → 2 缺口（与论文一致）', `gaps=${boundaryLoss.gaps}`);
    const midLoss = mkSeq([100, 101, 102, 106, 107]);
    ok(midLoss.gaps === 3, '中途丢 3 帧 → 3 缺口', `gaps=${midLoss.gaps}`);
    const legacyFrame = mkSeq([1, 2, 3, 4, 5, 0, 6, 7, 8]);
    ok(legacyFrame.gaps === 0 && legacyFrame.legacyFrames === 1,
       '流中插入序号 0（旧固件）→ 0 缺口，0 帧被排除（修正前为 65 535）',
       `gaps=${legacyFrame.gaps} legacy=${legacyFrame.legacyFrames}`);
    const dupFrame = mkSeq([10, 10, 11]);
    ok(dupFrame.gaps === 0, '重复帧不计缺口', `gaps=${dupFrame.gaps}`);

    // G4 Wilson 区间（式11）：零缺口 0/100 上界 3.7%
    const lm100 = mkSeq(Array.from({ length: 100 }, (_, i) => i + 1));
    const st100 = lm100.stats(200000);
    ok(Math.abs(st100.lossCI.hi - 0.0370) < 0.0005,
       'Wilson 95% 置信区间：零缺口 0/100 上界 3.7%（式11）', `hi=${(st100.lossCI.hi * 100).toFixed(2)}%`);
    ok(Math.abs(std.wilsonInterval(0, 50).hi - 0.0714) < 0.001,
       'Wilson 0/50 上界 7.14%（交叉核对）', `hi=${(std.wilsonInterval(0, 50).hi * 100).toFixed(2)}%`);

    // G5 自适应变周期（式(10)）：Pn=10 s、Pa=1 s、λ=5% → 0.388 MB/d，较固定 1 s 节省 85.5%
    const apc = new AdaptivePeriodController({ pnSec: 10, paSec: 1 });
    const bw5 = adaptiveBandwidth(0.05, 10, 1);
    ok(Math.abs(bw5 - 0.388) < 0.001, '式(10) λ=5% 自适应带宽 0.388 MB/d', `${bw5.toFixed(3)} MB/d`);
    const sv5 = 1 - bw5 / fixedBandwidth(1);
    ok(Math.abs(sv5 * 100 - 85.5) < 0.2, 'λ=5% 较固定 1 s 周期节省带宽 85.5%', `${(sv5 * 100).toFixed(1)}%`);
    const sv1 = 1 - adaptiveBandwidth(0.01, 10, 1) / fixedBandwidth(1);
    ok(Math.abs(sv1 * 100 - 89.1) < 0.2, 'λ=1% 节省带宽 89.1%', `${(sv1 * 100).toFixed(1)}%`);
    // 状态机：趋势预判触发 → 短周期
    apc.update(1.3, 2.0, 1000); const ad2 = apc.update(1.3, 2.0, 2000);
    ok(ad2.state === 'SUSPECT' && ad2.periodSec === 1, 'EWMA 趋势预判触发 → 切换至短周期 Pa=1 s', `${ad2.state}/${ad2.periodSec}s`);

    // G6 RUL（式8）：β 无偏、RUL = (x_th − x_now)/β
    const { beta: bHat } = linreg([0, 1, 2, 3, 4], [25, 26, 27, 28, 29]);
    ok(Math.abs(bHat - 1) < 1e-9, '最小二乘退化速率估计 β=1.0 ℃/min（无噪精确解）', `β=${bHat}`);
    const rp = new RULPredictor({ fitWindowMin: 60, minSlope: 0.001, thresholds: { t: 80 } });
    let rEst = null;
    for (let t = 0; t <= 600000; t += 60000) rEst = rp.push('t', t, 25 + 1.0 * (t / 60000));
    ok(rEst && Math.abs(rEst.rul - 45) < 0.5, '式(8) RUL=(80−35)/1=45 min', `RUL=${rEst && rEst.rul} min`);
    const rp2 = new RULPredictor({ fitWindowMin: 60, minSlope: 0.5, thresholds: { t: 80 } });
    let rEst2 = null;
    for (let t = 0; t <= 600000; t += 60000) rEst2 = rp2.push('t', t, 25 + 0.05 * (t / 60000));
    ok(rEst2 && rEst2.rul === null, '退化速率低于可辨识下限时不外推 RUL（防虚假趋势外推）', rEst2 && rEst2.note);

    report.sections.v1 = {
        tx: { normal: txNormal, anomaly: txAnomaly, daily0: +dailyMB(31).toFixed(3), daily100: +dailyMB(62).toFixed(3),
            baseline1: +base1.toFixed(3), baseline2: +base2.toFixed(2),
            compression1: +(base1 / dailyMB(31)).toFixed(2), compression2: +(base2 / dailyMB(31)).toFixed(2),
            compression1Full: +(base1 / dailyMB(62)).toFixed(2), compression2Full: +(base2 / dailyMB(62)).toFixed(2) },
        seqBoundary: { wrapCycle: wrapCycle.gaps, crossWrap: crossWrap.gaps, boundaryLoss: boundaryLoss.gaps, midLoss: midLoss.gaps, legacyFrame: legacyFrame.gaps, dup: dupFrame.gaps },
        wilson: { n100hi: +st100.lossCI.hi.toFixed(4), n50hi: +std.wilsonInterval(0, 50).hi.toFixed(4) },
        adaptive: { bw5: +bw5.toFixed(3), saving5: +(sv5 * 100).toFixed(1), saving1: +(sv1 * 100).toFixed(1) },
        rul: { beta: bHat, rul: rEst && rEst.rul },
    };

    /* ---------------- H. 碳滑板健康度与滚动板口径（前端缺陷回归） ---------------- */
    section('H 碳滑板健康度：滚动窗口 + 部件告警加权（修复"健康度恒为 100%"）');
    const healthIndex = require('../health-index.js');

    const HOUR = 3600000;
    const nowTs = Date.parse('2026-10-08T12:00:00Z');
    const demoList = [
        { content: '高压报警', time: new Date(nowTs - 0.5 * HOUR).toISOString() },   // 环境/气路类，应排除
        { content: '压力超限', time: '2026-10-04T06:40:41.300Z' },
        { content: '压力超限', time: '2026-10-04T02:40:41.300Z' },
        { content: '导高超限', time: '2026-10-03T11:40:41.300Z' },
        { content: '燃弧超限', time: '2026-10-03T01:40:41.300Z' },
        { content: '燃弧超限', time: '2026-10-02T05:40:41.300Z' },
        { content: '拉出值超限', time: '2026-09-30T03:40:41.300Z' },
    ];
    const hs = healthIndex.computeHealth(demoList, { now: nowTs });
    ok(hs.counted === 6, '窗口内计入 6 条受电弓部件告警', `counted=${hs.counted}`);
    ok(hs.excludedEnv === 1, '环境/气路类告警（高压报警）被排除，不参与扣减', `excludedEnv=${hs.excludedEnv}`);
    ok(hs.weightSum === 41, '加权和 = 10×2 + 8 + 5×2 + 3 = 41', `weightSum=${hs.weightSum}`);
    ok(hs.score === 80, '健康度 = 100 − 41×0.5 = 80（修复前恒为 100）', `score=${hs.score}`);
    ok(hs.grade === '关注' && hs.color === '#00d68f', '分级与配色：80 分 → 关注 / 绿色', `${hs.grade} ${hs.color}`);
    ok(!!hs.windowStart, '返回窗口起始日（供前端提示展示）', `windowStart=${hs.windowStart}`);

    // 关键回归：窗口外的历史告警不计入；窗口内新增告警应使分值下降
    const older = healthIndex.computeHealth(
        [{ content: '压力超限', time: '2024-01-01T00:00:00Z' }], { now: nowTs });
    ok(older.counted === 0 && older.score === 100, '窗口外告警不计入（30 天窗口）', `counted=${older.counted} score=${older.score}`);
    const empty = healthIndex.computeHealth([], { now: nowTs });
    ok(empty.score === 100 && empty.counted === 0, '无部件告警时 100 分（无数据不打分）', `score=${empty.score}`);
    const worse = healthIndex.computeHealth(
        demoList.concat([{ content: '压力超限', time: '2026-10-05T00:00:00Z' }]), { now: nowTs });
    ok(worse.score < hs.score, '窗口内新增一条压力超限 → 分值下降（健康度随数据变化）', `${hs.score} → ${worse.score}`);

    // 扣分上限：极多告警时钳位到 0 分
    const many = Array.from({ length: 300 }, () => ({ content: '压力超限', time: '2026-10-05T00:00:00Z' }));
    ok(healthIndex.computeHealth(many, { now: nowTs }).score === 0, '分值下界钳位到 0', `score=${healthIndex.computeHealth(many, { now: nowTs }).score}`);

    // dv-scroll-board 轮播前置条件：data.length 必须严格大于 rowNum
    // （库源码守卫 `if (rowNum >= rowsData.length) return`，不满足则永不滚动）
    const BASE_ROW_NUM = 5;
    function buildScrollData(len) {
        const base = Array.from({ length: len }, (_, i) => [i + 1, 'X']);
        const rowNum = Math.min(BASE_ROW_NUM, Math.max(1, base.length));
        let data = base;
        while (data.length > 0 && data.length <= rowNum) data = data.concat(base);
        return { data, rowNum };
    }
    const scrollOk = [1, 2, 3, 4, 5, 6, 8, 12].every((n) => {
        const { data, rowNum } = buildScrollData(n);
        return data.length > rowNum;
    });
    ok(scrollOk, '滚动板补足规则：1~12 条数据均满足 data.length > rowNum（保证循环滚动）',
       [1, 3, 5, 6].map((n) => { const b = buildScrollData(n); return `${n}→${b.data.length}/${b.rowNum}`; }).join(' '));
    ok(buildScrollData(0).data.length === 0, '零数据时不补足（由 v-else 显示"暂无预警数据"）');

    report.sections.health = {
        demoScore: hs.score, grade: hs.grade, counted: hs.counted,
        weightSum: hs.weightSum, excludedEnv: hs.excludedEnv,
        windowStart: hs.windowStart, worseScore: worse.score,
    };

    /* ---------------- I. 演示数据标记的对外剥除 ---------------- */
    section('I 备注去 [演示数据] 标记（库内保留、对外剥除）');
    const demoWarn = require('../demo-warnings.js');
    const MK = demoWarn.DEMO_MARK;

    ok(MK === '[演示数据]', '标记常量与设计一致', MK);
    ok(demoWarn.stripDemoMark(`${MK} 接触力峰值超上限，建议检查弓头压力`) === '接触力峰值超上限，建议检查弓头压力',
       '剥除标记并去掉紧随的空格', demoWarn.stripDemoMark(`${MK} 接触力峰值超上限，建议检查弓头压力`));
    ok(demoWarn.stripDemoMark(`${MK}紧贴文字`) === '紧贴文字', '兼容标记后无空格的历史写法', demoWarn.stripDemoMark(`${MK}紧贴文字`));
    ok(demoWarn.stripDemoMark('PLC判定：均值压力 1129.4kPa > 1000kPa') === 'PLC判定：均值压力 1129.4kPa > 1000kPa',
       '非演示记录的原样返回（不误伤真实备注）');
    ok(demoWarn.stripDemoMark('/') === '/' && demoWarn.stripDemoMark('') === '' &&
       demoWarn.stripDemoMark(null) === null && demoWarn.stripDemoMark(undefined) === undefined,
       '空值/占位符安全');

    // 关键：批量去标记不得修改入参（内存列表/DB 行需保留标记以支撑幂等与清理）
    const srcW = { id: 423, code: 'THB000001', remark: `${MK} 接触力峰值超上限` };
    const outW = demoWarn.stripDemoMarkOf(srcW);
    ok(srcW.remark.startsWith(MK), 'stripDemoMarkOf 不修改入参（库内标记必须保留）', srcW.remark.slice(0, 6));
    ok(outW.remark === '接触力峰值超上限', 'stripDemoMarkOf 返回去标记的新对象', outW.remark);

    // 关键：上下文合并依赖原始标记 → 必须先取上下文再剥标记
    ok(demoWarn.demoContextFor(srcW) !== null, '原始记录（带标记）可取得演示上下文');
    ok(demoWarn.demoContextFor(outW) === null, '已剥标记的记录不再命中上下文（故服务端须先取上下文）');
    ok(demoWarn.demoContextFor({ code: 'THB000001', remark: '普通备注' }) === null, '非演示记录不返回上下文');

    // 幂等种子与清理的判据字段未被破坏
    ok(String(MK).length > 0 && typeof demoWarn.seedDemoWarnings === 'function' &&
       typeof demoWarn.clearDemoWarnings === 'function',
       '幂等种子与清理接口保持可用（标记仍为唯一判据）');

    report.sections.demoMark = {
        mark: MK,
        stripped: demoWarn.stripDemoMark(`${MK} 接触力峰值超上限`),
        inputPreserved: srcW.remark.startsWith(MK),
        contextStillResolves: demoWarn.demoContextFor(srcW) !== null,
    };

    /* ---------------- 汇总 ---------------- */
    const summary = { pass, fail, generatedAt: new Date().toISOString(), results: report.sections };
    fs.mkdirSync(__dirname, { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(summary, null, 2));
    console.log(lines.join('\n'));
    console.log(`\n==== 测试汇总：PASS ${pass} / FAIL ${fail} ====`);
    console.log('指标报告：tests/report.json');
    process.exit(fail === 0 ? 0 : 1);
})();
