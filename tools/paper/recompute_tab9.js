// recompute_tab9.js —— 表9权威复算：纯阈值 vs EWMA 趋势检测时延
// 口径：白噪声 σ=0.3 ℃；阈值 80 ℃（温度 upper）；确认 2 点；EWMA λ=0.2、W=60 s
// 观测上限 3600 s；50 次试验取中位
'use strict';
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const LIMIT = 80, T0 = 25, SIG = 0.3, Wms = 60000, LAM = 0.2, ROC_WARN = 2.0;

// 纯阈值判据：温度 10 点滑窗均值 >= LIMIT，连续 2 点
function makeThresh() {
    let buf = [], over = 0;
    return function (t, x) {
        buf.push(x); if (buf.length > 10) buf.shift();
        const m = buf.reduce((a, b) => a + b, 0) / buf.length;
        over = (m >= LIMIT) ? over + 1 : 0;
        return over >= 2;
    };
}
// EWMA 趋势检测：中值3 → EWMA(λ) → roc=(Zi−Zi−W)/W >= rw，连续 2 点
function makeEWMA() {
    let Z = T0, buf = [], hist = [], over = 0;
    return function (t, x) {
        buf.push(x); if (buf.length > 3) buf.shift();
        const med = buf.length === 3 ? [...buf].sort((a, b) => a - b)[1] : x;
        Z = LAM * med + (1 - LAM) * Z;
        hist.push({ t, Z });
        const ref = hist.find(h => t - h.t >= Wms);
        if (!ref) return false;
        const roc = (Z - ref.Z) / ((t - ref.t) / 60000);
        over = (roc >= ROC_WARN) ? over + 1 : 0;
        return over >= 2;
    };
}
function median(a) { a = [...a].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; }

function run(factory, rate, trials, seedBase) {
    const lat = [];
    for (let i = 0; i < trials; i++) {
        const d = factory(); const r = rng(seedBase + i * 17);
        for (let t = 0; t <= 3600000; t += 1000) {
            // 100 ms 采样 → 每 1 s 给 10 个样本；简化为 1 s 一步但滑窗用 1 s 样本
            const rise = (rate / 60) * (t / 1000);
            if (d(t, T0 + rise + gauss(r) * SIG)) { lat.push(t / 1000); break; }
        }
    }
    return lat.length ? median(lat) : null;
}

const NT = 50;
console.log('=== 表9 权威复算（σ=0.3 ℃, 50 次试验中位, 上限 3600 s）===');
console.log('速率 | 纯阈值/s | EWMA/s | 提前/s');
for (const rate of [1, 2, 3, 5, 10]) {
    const th = run(makeThresh, rate, NT, 111000 + rate);
    const ew = run(makeEWMA, rate, NT, 900000 + rate);
    const adv = (th !== null && ew !== null) ? (th - ew) : '—';
    console.log(' ' + rate + '  | ' + (th === null ? '未检出' : th) + ' | ' + (ew === null ? '未检出' : ew) + ' | ' + adv);
}
console.log();
console.log('论文表9:  1->3303/3303/0  2->1653/73/1580  3->1103/61/1042  5->663/61/602  10->333/61/272');
