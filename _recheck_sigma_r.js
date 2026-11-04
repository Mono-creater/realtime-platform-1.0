/**
 * 独立复算 σr：用平台自身的滤波链（3 点中值 → EWMA → (Zi − Zi−W)/W）做蒙特卡洛
 * 论文式(6)（修正版）：σr = √(2λ/(2−λ))·σ/W
 * 代码现状（错误版）  ：σr = √(2λ/(2−λ))·(0.670σ)/W
 * 用法：node _recheck_sigma_r.js
 */
'use strict';
const { EwmaTrendDetector, median3 } = require('D:/realtime-platform1.0/ewma-trend.js');

function gaussFactory(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
}
function gauss(r) {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const SIGMA = 1.0, LAMBDA = 0.2, DT_MS = 1000, W_SAMPLES = 60, N = 3_000_000;

// ---------- 链 A：平台真实实现（EwmaTrendDetector.update）取样 ----------
// 为速度起见，用完全等价的内联实现；同时用真实类在小样本上交叉校验
function chainStats(N) {
    const rnd = gaussFactory(20261015);
    const mb = [];
    let z = undefined;
    const series = new Float64Array(N);
    const medSeries = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        const v = 25 + gauss(rnd) * SIGMA;
        mb.push(v); if (mb.length > 3) mb.shift();
        const med = mb.length >= 3 ? median3(mb[0], mb[1], mb[2]) : mb[mb.length - 1];
        medSeries[i] = med;
        z = z === undefined ? med : LAMBDA * med + (1 - LAMBDA) * z;
        series[i] = z;
    }
    function stats(arr, skip) {
        let s = 0, s2 = 0, n = 0;
        for (let i = skip; i < arr.length; i++) { s += arr[i]; s2 += arr[i] * arr[i]; n++; }
        const m = s / n; return { mean: m, variance: s2 / n - m * m, n };
    }
    const vMed = stats(medSeries, 100).variance;
    const vZ = stats(series, 100).variance;

    // Cov(Z_i, Z_{i-60}) 与 Var(Z_i − Z_{i−60})
    let sx = 0, sy = 0, sxy = 0, sd = 0, sd2 = 0, n = 0;
    for (let i = 100 + W_SAMPLES; i < N; i++) {
        const a = series[i], b = series[i - W_SAMPLES];
        sx += a; sy += b; sxy += a * b;
        const d = a - b; sd += d; sd2 += d * d; n++;
    }
    const mx = sx / n, my = sy / n;
    const cov = sxy / n - mx * my;
    const md = sd / n;
    const vd = sd2 / n - md * md;
    return {
        varMedian: vMed, varZ: vZ, cov60: cov,
        varDiff: vd, sigmaRocEmpirical: Math.sqrt(vd) / 1.0,   // W = 1 min
        n,
    };
}

const t0 = Date.now();
const r = chainStats(N);
console.log('==== 蒙特卡洛（σ=1.0 ℃，λ=0.2，W=1 min，Δt=1 s，N=%d）====', N);
console.log('Var(中值滤波输出)      =', r.varMedian.toFixed(6), '（比值 vs σ² =', r.varMedian.toFixed(4) + '）');
console.log('Var(Z)（EWMA）         =', r.varZ.toFixed(6));
console.log('Cov(Z_i, Z_i−60)       =', r.cov60.toExponential(3), '(占 Var(Z) 的', (r.cov60 / r.varZ * 100).toFixed(3) + '%)');
console.log('Var(Z_i − Z_i−60)      =', r.varDiff.toFixed(6));
console.log('σr 实测                =', r.sigmaRocEmpirical.toFixed(4), '℃·min⁻¹');
console.log('— 论文式(6)（不含 0.670）预测 =', (Math.SQRT2 * Math.sqrt(LAMBDA / (2 - LAMBDA)) * SIGMA / 1.0).toFixed(4));
console.log('— 代码现状（含 0.670）预测     =', (Math.SQRT2 * 0.66985 * Math.sqrt(LAMBDA / (2 - LAMBDA)) * SIGMA / 1.0).toFixed(4));
console.log('耗时 %d ms', Date.now() - t0);

// ---------- 交叉校验：平台真实类（小样本 200k）----------
{
    const det = new EwmaTrendDetector({ lambda: LAMBDA, windowMin: 1.0, sigma: SIGMA, prewarmMs: 0 });
    const rnd = gaussFactory(777);
    const rocs = [];
    for (let i = 0; i < 200000; i++) {
        const out = det.update({ t: i * DT_MS, temperature: 25 + gauss(rnd) * SIGMA });
        if (out.roc.temp !== null && out.roc.temp !== undefined) rocs.push(out.roc.temp);
    }
    let s = 0, s2 = 0;
    for (const v of rocs) { s += v; s2 += v * v; }
    const m = s / rocs.length;
    const sd = Math.sqrt(s2 / rocs.length - m * m);
    console.log('\n==== 平台真实类 EwmaTrendDetector（N=200k）====');
    console.log('roc 样本数 =', rocs.length, ' 均值 =', m.toExponential(2), ' σr(实测) =', sd.toFixed(4));
    console.log('解析（类内 analytics）σr =', det.analytics({ temp: 2 }).sigmaRoc.toFixed(4));
}

// ---------- 理论校验：3 点中值对方差的实际削减比 ----------
{
    const rnd = gaussFactory(4242);
    let s2 = 0, n = 0, m = 0;
    const buf = [];
    const out = [];
    for (let i = 0; i < 500000; i++) {
        buf.push(gauss(rnd)); if (buf.length > 3) buf.shift();
        if (buf.length === 3) out.push(median3(buf[0], buf[1], buf[2]));
    }
    let sum = 0; for (const v of out) sum += v; m = sum / out.length;
    for (const v of out) s2 += (v - m) * (v - m);
    console.log('\n3 点中值滤波输出的方差（纯高斯，N=500k）=', (s2 / out.length).toFixed(4),
        '  （代码用的 MEDIAN3_VAR_RATIO = 0.4487）');
}
