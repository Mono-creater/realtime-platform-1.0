// verify_latency.js —— 用 1.0 平台的 ewma-trend.js 复现论文表10 的检出时延
// 方法学与论文 4.1 节一致：与 d:/驭弓大师/10_创新升级/scan_lat.js 同参数、同种子口径
'use strict';
const { EwmaTrendDetector } = require('../ewma-trend.js');

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const ROC_WARN = 2.0;

function rampLat(rate, trials, seedBase, opts = {}) {
    const lats = [];
    for (let i = 0; i < trials; i++) {
        const d = new EwmaTrendDetector({ lambda: 0.2, windowMin: 1.0, sigma: 0.3, ...opts });
        const r = rng(seedBase + i * 17);
        let over = 0;
        for (let t = 0; t <= 7200000; t += 1000) {
            const x = 25 + (rate / 60) * (t / 1000) + gauss(r) * 0.3;
            const { roc } = d.update({ t, temperature: x });
            if (roc.temp === null) continue;
            over = (roc.temp >= ROC_WARN) ? over + 1 : 0;
            if (over >= 2) { lats.push(t / 1000); break; }
        }
    }
    if (!lats.length) return null;
    lats.sort((a, b) => a - b);
    return lats[Math.floor(lats.length / 2)];
}

console.log('rate(℃/min), ewma_latency_s   [论文表10: 1→不触发, 2→65, 3→61, 5→61, 10→61]');
for (const rate of [1, 2, 3, 5, 10]) {
    const ew = rampLat(rate, 60, 900000 + rate);
    console.log(`  ${String(rate).padStart(2)} -> ${ew === null ? '不触发' : ew + ' s'}`);
}

console.log('\n[对照] 纯阈值判据 = (80-25)/rate*60 + 3 s：');
for (const rate of [1, 2, 3, 5, 10]) console.log(`  ${String(rate).padStart(2)} -> ${((80 - 25) / rate * 60 + 3).toFixed(0)} s`);
