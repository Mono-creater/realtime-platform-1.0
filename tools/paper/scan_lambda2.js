// scan_lambda2.js —— 图6最终数据：λ∈{0.1,0.2,0.3,0.4,0.5} 误报率 + 3℃/min时延
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
function noiseFA(lambda, trials) {
    let hit = 0;
    for (let i = 0; i < trials; i++) {
        const d = makeEWMA(lambda, 25, 2); const r = rng(100000 + i * 17);
        for (let t = 0; t <= 300000; t += 1000) if (d(t, 25 + gauss(r) * 1.0)) { hit++; break; }
    }
    return hit / trials * 100;
}
function rampLat(lambda, rate, trials, seedBase) {
    const lats = [];
    for (let i = 0; i < trials; i++) {
        const d = makeEWMA(lambda, 25, 2); const r = rng(seedBase + i * 17);
        for (let t = 0; t <= 3600000; t += 1000) if (d(t, 25 + (rate / 60) * (t / 1000) + gauss(r) * 0.3)) { lats.push(t / 1000); break; }
    }
    if (!lats.length) return null;
    lats.sort((a, b) => a - b);
    return lats[Math.floor(lats.length / 2)];
}
const NT = 600;
console.log('lambda,fa_pct,lat3s');
for (const lam of [0.1, 0.2, 0.3, 0.4, 0.5]) {
    const fa = noiseFA(lam, NT);
    const l3 = rampLat(lam, 3, 60, 900000 + lam * 1000);
    console.log(lam.toFixed(1) + ',' + fa.toFixed(2) + ',' + (l3 === null ? 'NA' : l3));
}
