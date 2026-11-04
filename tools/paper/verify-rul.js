// verify-rul.js —— RUL 预测验证：最小二乘退化速率估计的准确性
'use strict';
const { linreg } = require('./rul-predictor.js');

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// 场景：温度从 25℃ 以 rate ℃/min 缓变，阈值 80℃，观测噪声 σ。
// 每 60s 一个滑窗均值采样，用最近 10min 窗口做最小二乘，预测 RUL，对比真实值。
function run(rate, threshold, sigma, winMin, trials) {
    const errs = [];
    for (let k = 0; k < trials; k++) {
        const r = rng(80000 + k * 17 + Math.round(rate * 100));
        let T = 25;
        const ts = [], xs = [];
        for (let t = 0; t <= 3600; t += 60) {   // 采样 60s 一次
            T = 25 + rate * (t / 60);
            const x = T + gauss(r) * sigma;
            ts.push(t / 60); xs.push(x);
            // 观测满 winMin 分钟后开始预测
            if (t / 60 >= winMin && T < threshold - 2) {
                const now = t / 60;
                const w = [];
                for (let i = ts.length - 1; i >= 0 && now - ts[i] <= winMin; i--) w.push({ t: ts[i], x: xs[i] });
                const wts = w.map((h) => h.t), wxs = w.map((h) => h.x);
                const { beta } = linreg(wts, wxs);
                if (Math.abs(beta) > 0.05) {
                    const trueRUL = (threshold - T) / rate;
                    const predRUL = (threshold - x) / beta;
                    if (trueRUL > 0) errs.push((predRUL - trueRUL) / trueRUL * 100);
                }
            }
        }
    }
    errs.sort((a, b) => a - b);
    const med = errs.length ? errs[Math.floor(errs.length / 2)] : null;
    return { med, n: errs.length };
}

console.log('==== RUL 预测验证（最小二乘退化速率估计，阈值 80℃）====');
for (const [rate, sigma, winMin] of [[0.5, 0.3, 10], [1.0, 0.3, 10], [2.0, 0.3, 10], [1.0, 1.0, 10], [1.0, 0.3, 20]]) {
    const res = run(rate, 80, sigma, winMin, 30);
    console.log(`  rate=${rate}℃/min σ=${sigma}℃ 窗口=${winMin}min: RUL 预测误差中位 ${res.med === null ? '无' : res.med.toFixed(1) + '%'}（样本 ${res.n}）`);
}
