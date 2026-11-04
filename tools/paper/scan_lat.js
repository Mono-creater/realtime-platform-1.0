// scan_lat.js —— 复核表9全部速率（λ=0.2, 60次试验中位）
'use strict';
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const ROC_WARN = 2.0, W = 60000;
function makeEWMA(lambda, mu0, confirmN) {
    let Z = mu0, hist = [], over = 0, buf = [];
    return function (t, x) {
        buf.push(x); if (buf.length > 3) buf.shift();
        const med = buf.length === 3 ? [...buf].sort((a, b) => a - b)[1] : x;
        Z = lambda * med + (1 - lambda) * Z; hist.push({ t, Z });
        const ref = hist.find((h) => t - h.t >= W);
        if (!ref) return false;
        const roc = (Z - ref.Z) / ((t - ref.t) / 60000);
        over = (roc >= ROC_WARN) ? over + 1 : 0;
        return over >= confirmN;
    };
}
function makeThresh(limit, mu0) { let over = 0; return function (t, x) { over = (x >= limit) ? over + 1 : 0; return over >= 2; }; }
function rampLat(factory, rate, trials, seedBase) {
    const lats = [];
    for (let i = 0; i < trials; i++) {
        const d = factory(); const r = rng(seedBase + i * 17);
        for (let t = 0; t <= 7200000; t += 1000) if (d(t, 25 + (rate / 60) * (t / 1000) + gauss(r) * 0.3)) { lats.push(t / 1000); break; }
    }
    if (!lats.length) return null;
    lats.sort((a, b) => a - b);
    return lats[Math.floor(lats.length / 2)];
}
console.log('rate,threshold_s,ewma_s');
for (const rate of [1, 2, 3, 5, 10]) {
    const th = rampLat(() => makeThresh(28, 25), rate, 30, 111000 + rate);
    const ew = rampLat(() => makeEWMA(0.2, 25, 2), rate, 60, 900000 + rate);
    console.log(rate + ',' + (th === null ? 'NA' : th) + ',' + (ew === null ? 'NA' : ew));
}
