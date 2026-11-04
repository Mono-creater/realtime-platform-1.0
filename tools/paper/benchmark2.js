// benchmark2.js —— EWMA 趋势检测性能数据（论文表格用，300 次试验稳定统计）
// 修正：每次试验独立创建检测器实例，避免状态跨试验污染。
'use strict';
const { AlarmEngine } = require('./alarm-engine.js');

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const BASE = { pressure: 500, humidity: 50 };
const ROC_WARN = 2.0, W = 60000;

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
function makeCUSUM(k, h, mu0) { let S = 0; return function (t, x) { S = Math.max(0, S + (x - mu0) - k); return S > h; }; }
function makeOriginal() {
    const e = new AlarmEngine({ voteEnabled: true, voteSlopeMode: 'hybrid', confirmN: 2, voteWindowMs: 90000, voteRatio: 0.5, voteMinSamples: 2, slopeSpanMs: 20000 });
    return function (t, x) { return e.push({ t, ...BASE, temperature: x, truthOnsetMs: 0 }).length > 0; };
}

function noiseFA(factory, trials) {
    let hit = 0;
    for (let i = 0; i < trials; i++) {
        const detect = factory();
        const r = rng(100000 + i * 17);
        for (let t = 0; t <= 300000; t += 1000) if (detect(t, 25 + gauss(r) * 1.0)) { hit++; break; }
    }
    return hit;
}
function spikeFA(factory, trials) {
    let hit = 0;
    for (let i = 0; i < trials; i++) {
        const detect = factory();
        const r = rng(200000 + i * 17); let g = r() * 2 - 1;
        for (let t = 0; t <= 300000; t += 1000) {
            g = g * 0.9 + (r() * 2 - 1) * 0.1;
            if (detect(t, 25 + g + ((t % 30000 === 15000) ? 70 : 0))) { hit++; break; }
        }
    }
    return hit;
}
function rampLat(factory, rate, trials, seedBase) {
    const lats = [];
    for (let i = 0; i < trials; i++) {
        const detect = factory();
        const r = rng(seedBase + i * 17);
        for (let t = 0; t <= 3600000; t += 1000) {
            if (detect(t, 25 + (rate / 60) * (t / 1000) + gauss(r) * 0.3)) { lats.push(t / 1000); break; }
        }
    }
    if (!lats.length) return null;
    lats.sort((a, b) => a - b);
    return lats[Math.floor(lats.length / 2)];
}

const NT = 300;
console.log('==== EWMA 趋势检测性能数据（'+NT+' 次试验）====');
console.log('噪声误报 σ=1.0℃ (300s×'+NT+'):');
console.log('  原方法:', noiseFA(() => makeOriginal(), NT), '/', NT);
console.log('  EWMA:  ', noiseFA(() => makeEWMA(0.1, 25, 2), NT), '/', NT);
console.log('  CUSUM: ', noiseFA(() => makeCUSUM(1.0, 10, 25), NT), '/', NT);
console.log('尖峰误报 (300s×'+NT+'):');
console.log('  原方法:', spikeFA(() => makeOriginal(), NT), '/', NT);
console.log('  EWMA:  ', spikeFA(() => makeEWMA(0.1, 25, 2), NT), '/', NT);
console.log('  CUSUM: ', spikeFA(() => makeCUSUM(1.0, 10, 25), NT), '/', NT);
console.log('缓变检测时延（30 次试验中位，s）:');
for (const rate of [2, 3, 5, 10]) {
    const o = rampLat(() => makeOriginal(), rate, 30, 300000 + rate);
    const e = rampLat(() => makeEWMA(0.1, 25, 2), rate, 30, 400000 + rate);
    const c = rampLat(() => makeCUSUM(1.0, 10, 25), rate, 30, 500000 + rate);
    console.log('  ' + rate + '℃/min: 原方法=' + (o === null ? '未检出' : o) + '  EWMA=' + (e === null ? '未检出' : e) + '  CUSUM=' + (c === null ? '未检出' : c));
}
