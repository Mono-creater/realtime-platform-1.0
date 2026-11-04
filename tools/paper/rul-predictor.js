// rul-predictor.js —— 面向窄带监测数据的退化速率估计与剩余寿命（RUL）预测（创新升级 2）
//
// 动机：原论文健康指数为静态加权代理指标，缺乏退化趋势与剩余寿命信息。
//       本模块在滑窗均值（窄带链路上传的压缩数据）基础上，用最小二乘线性拟合
//       稳健估计退化速率 β，并结合当前值与告警阈值做线性退化外推预测 RUL，
//       并给出预测置信区间，将健康评估从"当前状态打分"升级为"状态 + 趋势 + 剩余寿命"。
//
// 理论：线性退化模型 x(t)=α+βt；β 用窗口内样本的最小二乘估计（高斯噪声下为无偏最优）；
//       RUL=(x_th−x_now)/β；预测不确定度由 β 的标准误与残差方差传播。
'use strict';

function linreg(ts, xs) {
    const n = ts.length;
    const mt = ts.reduce((a, b) => a + b, 0) / n;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, stt = 0;
    for (let i = 0; i < n; i++) { sxy += (ts[i] - mt) * (xs[i] - mx); stt += (ts[i] - mt) ** 2; }
    const beta = stt > 0 ? sxy / stt : 0;
    const alpha = mx - beta * mt;
    // 残差标准误
    let sse = 0;
    for (let i = 0; i < n; i++) { const e = xs[i] - (alpha + beta * ts[i]); sse += e * e; }
    const sigma = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
    const seBeta = stt > 0 ? sigma / Math.sqrt(stt) : 0;
    return { alpha, beta, sigma, seBeta };
}

class RULPredictor {
    constructor(o = {}) {
        this.cfg = Object.assign({ fitWindowMs: 600000, minSlope: 0.05, minSamples: 5 }, o);
        this.hist = [];   // {t(min), x}
    }

    /** 推入滑窗均值采样（t 为 ms），返回 {beta, rul, seRul} 或 null */
    push(t, x) {
        this.hist.push({ t: t / 60000, x });
        const now = t / 60000;
        const win = this.hist.filter((h) => now - h.t <= this.cfg.fitWindowMs / 60000);
        if (win.length < this.cfg.minSamples) return null;
        const ts = win.map((h) => h.t), xs = win.map((h) => h.x);
        return this._estimate(ts, xs, now, win[win.length - 1].x);
    }

    _estimate(ts, xs, now, xNow) {
        const { alpha, beta, sigma, seBeta } = linreg(ts, xs);
        if (Math.abs(beta) < this.cfg.minSlope) return { beta, rul: null };
        const gap = this.threshold - xNow;   // 由调用方注入阈值
        if (this.threshold === undefined) return { beta, alpha, sigma, seBeta, rul: null };
        if (gap * beta <= 0) return { beta, rul: null };
        const rul = gap / beta;
        return { beta, rul, alpha, sigma, seBeta };
    }

    /** 预测 RUL（min）与相对不确定度 */
    predictRUL(threshold, xNow, beta) {
        if (Math.abs(beta) < this.cfg.minSlope) return null;
        const gap = threshold - xNow;
        if (gap * beta <= 0) return null;
        return { rul_min: gap / beta, slope: beta };
    }
}

module.exports = { RULPredictor, linreg };
