// verify_rul.js —— RUL 预测无偏性验证（论文 §4.5：预测误差中位不超过 0.1%）
// 与 d:/驭弓大师/10_创新升级/verify-rul.js 同口径，改调用 1.0 平台的 rul-predictor.js
'use strict';
const { linreg } = require('../rul-predictor.js');

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

function run(rate, threshold, sigma, winMin, trials) {
    const errs = [];
    for (let k = 0; k < trials; k++) {
        const r = rng(80000 + k * 17 + Math.round(rate * 100));
        let T = 25;
        const ts = [], xs = [];
        for (let t = 0; t <= 3600; t += 60) {
            T = 25 + rate * (t / 60);
            const x = T + gauss(r) * sigma;
            ts.push(t / 60); xs.push(x);
            if (t / 60 >= winMin && T < threshold - 2) {
                const now = t / 60;
                const wts = [], wxs = [];
                for (let i = ts.length - 1; i >= 0 && now - ts[i] <= winMin; i--) { wts.push(ts[i]); wxs.push(xs[i]); }
                const { beta } = linreg(wts, wxs);
                if (Math.abs(beta) > 0.05) {
                    const trueRUL = (threshold - T) / rate;
                    const predRUL = (threshold - x) / beta;      // 式(8)
                    if (trueRUL > 0) errs.push((predRUL - trueRUL) / trueRUL * 100);
                }
            }
        }
    }
    errs.sort((a, b) => a - b);
    const med = errs.length ? errs[Math.floor(errs.length / 2)] : null;
    return { med, n: errs.length };
}

console.log('==== RUL 预测验证（1.0 平台 rul-predictor.js，阈值 80 ℃）====');
console.log('   论文 §4.5：0.5~2 ℃/min、0.3~1.0 ℃ 噪声下，预测误差中位不超过 0.1%');
for (const [rate, sigma, winMin] of [[0.5, 0.3, 10], [1.0, 0.3, 10], [2.0, 0.3, 10], [1.0, 1.0, 10], [1.0, 0.3, 20]]) {
    const res = run(rate, 80, sigma, winMin, 30);
    console.log(`  rate=${rate} ℃/min  σ=${sigma} ℃  窗=${winMin} min: 误差中位 ${res.med === null ? '无' : res.med.toFixed(1) + '%'}（样本 ${res.n}）`);
}
