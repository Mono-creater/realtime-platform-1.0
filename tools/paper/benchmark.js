// benchmark.js —— 缓变劣化检测方法对比基准
// 对比三种方法在"纯噪声误报、单点尖峰误报、缓变检测时延"上的性能：
//   1. 原方法：中值滤波 + 变化率差分 + 时间窗持续性投票（alarm-engine.js hybrid）
//   2. EWMA 方法（本文升级）：EWMA 平滑 + EWMA 斜率变化率 + 连续确认
//   3. CUSUM 方法：标准累积和（均值漂移检测）
// 目的：为论文提供"有理论支撑的 EWMA 缓变检测"升级依据，正面回应
//       "时间窗投票 FAR 比 CUSUM 高、凭什么更好"的评审质疑。
'use strict';
const { AlarmEngine } = require('./alarm-engine.js');

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const BASE = { pressure: 500, humidity: 50 };
const ROC_WARN = 2.0;   // 温度变化率 warning 阈值 ℃/min
const W = 60000;        // 变化率窗口 60 s

// ---------- EWMA 缓变检测器（本文升级方法）----------
// 中值滤波（抗单点尖峰）+ EWMA 平滑 + EWMA 斜率变化率 + 连续确认。
// 相对原方法的关键改进：以 EWMA 序列斜率替代"原始差分 + 时间窗投票"，
// 使阈值通道与变化率通道统一于同一平滑序列，从根源消除"滤波不一致"，
// 且 EWMA 方差 σ²·λ/(2-λ) 可解析，控制限可理论计算（GB/T 17989.6-2022）。
function makeEWMA(lambda, mu0, confirmN) {
    let Z = mu0, hist = [], over = 0, buf = [];
    return function (t, x) {
        buf.push(x); if (buf.length > 3) buf.shift();
        const med = buf.length === 3 ? [...buf].sort((a, b) => a - b)[1] : x;
        Z = lambda * med + (1 - lambda) * Z;
        hist.push({ t, Z });
        const ref = hist.find((h) => t - h.t >= W);
        if (!ref) return false;
        const roc = (Z - ref.Z) / ((t - ref.t) / 60000);
        over = (roc >= ROC_WARN) ? over + 1 : 0;
        return over >= confirmN;
    };
}

// ---------- CUSUM 检测器（标准累积和，均值漂移）----------
// 标定 k、h 使其在 σ=1℃ 白噪声下近似零误报（ARL_0 足够大）。
function makeCUSUM(k, h, mu0) {
    let S = 0;
    return function (t, x) {
        S = Math.max(0, S + (x - mu0) - k);
        return S > h;
    };
}

// ---------- 场景 1：纯噪声误报 ----------
function noiseFalseAlarm(detect, sig, durMs, trials, seedBase) {
    let hit = 0, total = 0;
    for (let i = 0; i < trials; i++) {
        const r = rng(seedBase + i * 17);
        let alarmed = false;
        for (let t = 0; t <= durMs; t += 1000) {
            if (detect(t, 25 + gauss(r) * sig)) { alarmed = true; break; }
        }
        if (alarmed) hit++;
    }
    return { hit, trials, pct: hit / trials * 100 };
}

// ---------- 场景 2：单点尖峰误报 ----------
function spikeFalseAlarm(detect, trials, seedBase, durMs) {
    let total = 0;
    for (let i = 0; i < trials; i++) {
        const r = rng(seedBase + i * 17);
        let g = r() * 2 - 1;
        for (let t = 0; t <= durMs; t += 1000) {
            g = g * 0.9 + (r() * 2 - 1) * 0.1;
            const x = 25 + g + ((t % 30000 === 15000) ? 70 : 0);
            if (detect(t, x)) { total++; break; }
        }
    }
    return { alarms: total, pct: total / trials * 100 };
}

// ---------- 场景 3：缓变检测时延 ----------
function rampLatency(detect, rateCperMin, durMs, seed) {
    const r = rng(seed);
    for (let t = 0; t <= durMs; t += 1000) {
        const x = 25 + (rateCperMin / 60) * (t / 1000) + gauss(r) * 0.3;
        if (detect(t, x)) return t / 1000;
    }
    return null;
}

// ============ 参数标定：各方法在"零误报"约束下 ============
// 原方法（alarm-engine hybrid T=90s ρ=0.5），论文标定的工作点
function makeOriginal() {
    const e = new AlarmEngine({
        voteEnabled: true, voteSlopeMode: 'hybrid', confirmN: 2,
        voteWindowMs: 90000, voteRatio: 0.5, voteMinSamples: 2, slopeSpanMs: 20000,
    });
    return function (t, x) {
        const a = e.push({ t, ...BASE, temperature: x, truthOnsetMs: 0 });
        return a.length > 0;
    };
}
// EWMA 方法（中值滤波 + λ=0.1 + EWMA 斜率 + 连续确认 2 点）
const EWMA_LAMBDA = 0.1, EWMA_CONFIRM = 2;
// CUSUM 方法（k、h 标定使其在 σ=1℃ 白噪声下零误报）
const CUSUM_K = 1.0, CUSUM_H = 10.0;

console.log('==== 场景1：纯噪声误报（σ=1.0℃ 白噪声，300s × 200 次）====');
const nOrig = noiseFalseAlarm(makeOriginal(), 1.0, 300000, 200, 100000);
const nEWMA = noiseFalseAlarm(makeEWMA(EWMA_LAMBDA, 25, EWMA_CONFIRM), 1.0, 300000, 200, 200000);
const nCUSUM = noiseFalseAlarm(makeCUSUM(CUSUM_K, CUSUM_H, 25), 1.0, 300000, 200, 300000);
console.log(`  原方法(中值+投票): ${nOrig.hit}/${nOrig.trials} (${nOrig.pct}%)`);
console.log(`  EWMA(λ=0.1):      ${nEWMA.hit}/${nEWMA.trials} (${nEWMA.pct}%)`);
console.log(`  CUSUM(k=1.0,h=10):  ${nCUSUM.hit}/${nCUSUM.trials} (${nCUSUM.pct}%)`);

console.log('==== 场景2：单点尖峰误报（1750 尖峰等价，200 次×300s）====');
const sOrig = spikeFalseAlarm(makeOriginal(), 200, 300000, 300000);
const sEWMA = spikeFalseAlarm(makeEWMA(EWMA_LAMBDA, 25, EWMA_CONFIRM), 200, 400000, 300000);
const sCUSUM = spikeFalseAlarm(makeCUSUM(CUSUM_K, CUSUM_H, 25), 200, 500000, 300000);
console.log(`  原方法: ${sOrig.alarms}/${sOrig.pct}%`);
console.log(`  EWMA:   ${sEWMA.alarms}/${sEWMA.pct}%`);
console.log(`  CUSUM:  ${sCUSUM.alarms}/${sCUSUM.pct}%`);

console.log('==== 场景3：缓变检测时延（观测上限 3600s）====');
for (const rate of [2, 3, 5]) {
    const lOrig = rampLatency(makeOriginal(), rate, 3600000, 600000 + rate);
    const lEWMA = rampLatency(makeEWMA(EWMA_LAMBDA, 25, EWMA_CONFIRM), rate, 3600000, 700000 + rate);
    const lCUSUM = rampLatency(makeCUSUM(CUSUM_K, CUSUM_H, 25), rate, 3600000, 800000 + rate);
    console.log(`  ${rate}℃/min: 原方法=${lOrig === null ? '未检出' : lOrig + 's'}  EWMA=${lEWMA === null ? '未检出' : lEWMA + 's'}  CUSUM=${lCUSUM === null ? '未检出' : lCUSUM + 's'}`);
}
