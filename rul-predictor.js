/**
 * rul-predictor.js —— 退化速率估计与剩余寿命（RUL）预测（论文 §3.2）
 *
 * 论文原文：
 *   "为弥补健康指数缺乏退化趋势与剩余寿命信息的不足，本文以滑窗均值序列上的
 *    最小二乘线性拟合估计各监测量的退化速率 β，结合当前值与告警阈值做线性退化
 *    外推，预测剩余寿命（remaining useful life，RUL）[20]：
 *      （10）RUL = (x_th − x_now)/β，式中 x_th 为告警阈值、x_now 为当前值。
 *    由于窄带链路仅上传滑窗均值而非原始波形，最小二乘拟合须在滑窗均值序列上进行；
 *    仿真验证表明，在 0.5～2 ℃/min 退化速率、0.3～1.0 ℃ 观测噪声下，
 *    RUL 预测误差中位不超过 0.1%，验证了该估计的无偏性。"
 *
 * 本模块实现：
 *   1) 滑窗均值序列上的最小二乘线性拟合 → 退化速率 β（含残差标准误与 β 的标准误）；
 *   2) 线性外推 RUL = (x_th − x_now)/β；
 *   3) 不确定度传播：β 的置信区间 → RUL 的置信区间（供工程判读，不夸大精度）；
 *   4) 多监测量（温度/压力/湿度/接触力）统一接口。
 *
 * 无第三方依赖。
 */

'use strict';

/**
 * 最小二乘线性拟合 x = α + β·t
 * @param {number[]} ts 时间序列（min）
 * @param {number[]} xs 观测序列
 * @returns {{alpha:number, beta:number, sigma:number, seBeta:number, n:number, r2:number}}
 */
function linreg(ts, xs) {
    const n = ts.length;
    if (n < 2) return { alpha: NaN, beta: NaN, sigma: 0, seBeta: 0, n, r2: 0 };
    const mt = ts.reduce((a, b) => a + b, 0) / n;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, stt = 0;
    for (let i = 0; i < n; i++) { sxy += (ts[i] - mt) * (xs[i] - mx); stt += (ts[i] - mt) ** 2; }
    const beta = stt > 0 ? sxy / stt : 0;
    const alpha = mx - beta * mt;
    let sse = 0, sst = 0;
    for (let i = 0; i < n; i++) {
        const e = xs[i] - (alpha + beta * ts[i]); sse += e * e;
        sst += (xs[i] - mx) ** 2;
    }
    const sigma = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
    const seBeta = stt > 0 ? sigma / Math.sqrt(stt) : 0;
    const r2 = sst > 0 ? 1 - sse / sst : 0;
    return { alpha, beta, sigma, seBeta, n, r2 };
}

/** 学生 t 分位数近似（95% 双侧，按自由度）——用于 RUL 区间，避免引入统计库依赖 */
function tQuantile95(df) {
    if (df <= 0) return NaN;
    if (df === 1) return 12.706;
    if (df === 2) return 4.303;
    if (df === 3) return 3.182;
    if (df === 4) return 2.776;
    if (df === 5) return 2.571;
    if (df <= 8) return 2.306 + (8 - df) * 0.05;
    if (df <= 15) return 2.131 + (15 - df) * 0.02;
    if (df <= 30) return 2.042 + (30 - df) * 0.0045;
    return 1.96;
}

class RULPredictor {
    /**
     * @param {object} opts
     * @param {number} [opts.fitWindowMin=10]  拟合窗口（min），论文口径为滑窗均值序列
     * @param {number} [opts.minSlope=0.01]    最小可辨识退化速率（|β| 低于此值判为无趋势）
     * @param {number} [opts.minSamples=5]     最少样本数
     * @param {object} [opts.thresholds]       {sig: x_th} 各监测量的告警阈值
     */
    constructor(opts = {}) {
        this.cfg = Object.assign({
            fitWindowMin: 10,
            minSlope: 0.01,
            minSamples: 5,
            thresholds: {},
        }, opts);
        /** @type {Object<string, Array<{t:number,x:number}>>} 各监测量历史（t 单位 min） */
        this.hist = {};
        /** 因乱序/重复时刻被忽略的样本数（可观测，便于排查时钟问题） */
        this.rejected = 0;
    }

    setThreshold(sig, xth) { this.cfg.thresholds[sig] = xth; }

    /**
     * 推入一个滑窗均值采样
     * @param {string} sig 监测量标识（temperature/pressure/humidity/contactForce）
     * @param {number} tMs 时刻（ms）
     * @param {number} x 滑窗均值
     */
    push(sig, tMs, x) {
        if (x === undefined || x === null || Number.isNaN(x)) return null;
        if (!Number.isFinite(tMs)) return null;
        const t = tMs / 60000;
        const h = this.hist[sig] || (this.hist[sig] = []);
        // 单调性守卫：乱序或重复时刻的样本会污染最小二乘拟合，直接忽略并计数
        if (h.length && t <= h[h.length - 1].t) {
            this.rejected = (this.rejected || 0) + 1;
            return this.estimate(sig, h[h.length - 1].t);
        }
        h.push({ t, x });
        const cutoff = t - this.cfg.fitWindowMin;
        while (h.length && h[0].t < cutoff) h.shift();
        return this.estimate(sig, t);
    }

    /**
     * 当前估计
     * @returns {?{beta:number, rul:?number, rulLo:?number, rulHi:?number, sigma:number, seBeta:number, r2:number, n:number, note:string}}
     */
    estimate(sig, nowMin) {
        const h = this.hist[sig] || [];
        if (h.length < this.cfg.minSamples) return null;
        const ts = h.map((p) => p.t), xs = h.map((p) => p.x);
        const { alpha, beta, sigma, seBeta, n, r2 } = linreg(ts, xs);
        const out = {
            beta: +beta.toFixed(6), sigma: +sigma.toFixed(4), seBeta: +(seBeta || 0).toFixed(6),
            r2: +r2.toFixed(4), n, rul: null, rulLo: null, rulHi: null, alpha,
            note: '',
        };
        if (Math.abs(beta) < this.cfg.minSlope) {
            out.note = `退化速率 |β|=${Math.abs(beta).toExponential(2)} 低于可辨识下限 ${this.cfg.minSlope}，判定为无显著退化趋势`;
            return out;
        }
        const xth = this.cfg.thresholds[sig];
        if (xth === undefined) {
            out.note = '未配置告警阈值 x_th，仅输出退化速率'; return out;
        }
        const xNow = xs[xs.length - 1];
        const gap = xth - xNow;
        if (gap * beta <= 0) {
            out.note = beta > 0 ? '当前值已在阈值之外（x_now ≥ x_th），或退化方向背离阈值' : '退化方向背离阈值，不外推 RUL';
            return out;
        }
        const rul = gap / beta;                       // 式(8)
        out.rul = +rul.toFixed(2);
        // 不确定度：β 的 95% 置信区间反推 RUL 区间（β 越小 RUL 越大）
        const df = n - 2;
        const tq = tQuantile95(df);
        if (Number.isFinite(tq) && seBeta > 0) {
            const betaLo = beta - tq * seBeta;
            const betaHi = beta + tq * seBeta;
            if (betaLo > 0) out.rulHi = +(gap / betaLo).toFixed(2);   // β 下限 → RUL 上限
            if (betaHi > 0) out.rulLo = +(gap / betaHi).toFixed(2);   // β 上限 → RUL 下限
        }
        out.note = `RUL = (x_th−x_now)/β = (${xth}−${xNow.toFixed(3)})/${beta.toFixed(5)} = ${out.rul} min`;
        return out;
    }

    /** 清零某监测量（检修后重新计时） */
    reset(sig) { if (sig) this.hist[sig] = []; else this.hist = {}; }
}

module.exports = { RULPredictor, linreg, tQuantile95 };
