'use strict';
/**
 * _recheck_prewarm.js —— 冷启动瞬态诊断复测（2026-10 复检用，临时脚本，非平台正式代码）
 *
 * 目的（配合式(6) 勘误）：
 *  1) 实测"窗口刚满后首个差分"的标准差 vs 稳态差分标准差
 *     —— 更新 ewma-trend.js 类注释中"σ≈1.0 vs 稳态 0.316 / 方差约 20 倍"等旧值；
 *  2) 复测"每次试验独立冷启动"的伪告警比例（prewarmMs=0 vs 15000）；
 *  3) 核对修正后 analytics() 暴露字段（sigmaZ/sigmaEff/σr/δmin/噪声边界/裕度）。
 *
 * 运行：node _recheck_prewarm.js
 */

const { EwmaTrendDetector, sigmaRoc } = require('./ewma-trend.js');
const { AlarmEngine } = require('./alarm-engine.js');

const LAMBDA = 0.2, SIGMA = 1.0, W = 1.0;

// 确定性 RNG（与 tests/run-tests.js 同款，保证可复现）
function _rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function _gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// ---------- 1) 冷启动首个差分（窗口刚满 60 s）的标准差 ----------
{
    const N = 20000;
    const r = _rng(777);
    let n = 0, sum = 0, sum2 = 0;
    for (let k = 0; k < N; k++) {
        const det = new EwmaTrendDetector({ lambda: LAMBDA, windowMin: W, sigma: SIGMA, prewarmMs: 0 });
        let first = null;
        for (let t = 0; t <= 60000; t += 1000) {
            const out = det.update({ t, temperature: 25 + _gauss(r) });
            if (first === null && out.roc.temp !== null) first = out.roc.temp;
        }
        if (first !== null) { n += 1; sum += first; sum2 += first * first; }
    }
    const mean = sum / n, vv = sum2 / n - mean * mean;
    console.log(`[1] 冷启动首个差分（独立短试验 ${n} 次）：σ = ${Math.sqrt(vv).toFixed(4)} ℃·min⁻¹（均值 ${mean.toFixed(4)}）`);
    console.log(`    理论参考 √(Var z0 + Var z60) = √(1.000 0 + ${(SIGMA * SIGMA * LAMBDA / (2 - LAMBDA)).toFixed(4)}) = ${Math.sqrt(1 + SIGMA * SIGMA * LAMBDA / (2 - LAMBDA)).toFixed(4)}`);
}

// ---------- 2) 稳态差分标准差（长序列） ----------
{
    const r = _rng(4242);
    const det = new EwmaTrendDetector({ lambda: LAMBDA, windowMin: W, sigma: SIGMA, prewarmMs: 0 });
    let n = 0, sum = 0, sum2 = 0;
    const TOTAL = 1000000;
    const t0 = Date.now();
    for (let i = 0; i < TOTAL; i++) {
        const t = i * 1000;
        const out = det.update({ t, temperature: 25 + _gauss(r) });
        if (out.roc.temp !== null && t > 120000) { n += 1; const x = out.roc.temp; sum += x; sum2 += x * x; }
    }
    const mean = sum / n, vv = sum2 / n - mean * mean;
    console.log(`[2] 稳态差分（${(n / 1e6).toFixed(3)}M 点）：σ = ${Math.sqrt(vv).toFixed(4)} ℃·min⁻¹（耗时 ${((Date.now() - t0) / 1000).toFixed(1)} s）`);
    console.log(`    解析式(6)（修正后）= ${sigmaRoc(SIGMA, LAMBDA, W).toFixed(4)}`);
}

// ---------- 3) 伪告警率复测：每次试验独立冷启动 ----------
{
    function trialAlarms(seed, prewarmMs, ticks = 300) {
        const r = _rng(seed);
        const e = new AlarmEngine({ sigma: SIGMA, lambda: LAMBDA, windowMin: W, confirmN: 2, suppressMs: 0, prewarmMs });
        let n = 0;
        for (let i = 0; i < ticks; i++) n += e.push({ t: i * 1000, temperature: 25 + _gauss(r) * SIGMA }).length;
        return n;
    }
    for (const prewarm of [0, 15000]) {
        let trials = 0, withAlarm = 0, total = 0;
        for (let s = 1; s <= 300; s++) {
            const n = trialAlarms(1000 + s * 17, prewarm);
            trials += 1; if (n > 0) withAlarm += 1; total += n;
        }
        console.log(`[3] prewarmMs=${prewarm}：${trials} 次独立短试验 → 伪告警 ${total} 条，涉及 ${withAlarm} 次试验（${(100 * withAlarm / trials).toFixed(1)}%）`);
    }
}

// ---------- 4) analytics() 字段核对 ----------
{
    const det = new EwmaTrendDetector({ lambda: LAMBDA, windowMin: W, sigma: SIGMA });
    const a = det.analytics({ temp: 2.0 });
    console.log('[4] analytics：', JSON.stringify({
        sigma: a.sigma, sigmaEff: +a.sigmaEff.toFixed(4), sigmaZ: +a.sigmaZ.toFixed(4),
        sigmaRoc: +a.sigmaRoc.toFixed(4), deltaMin: +a.deltaMin.toFixed(4),
        noiseBoundaryTemp: +a.noiseBoundary.temp.toFixed(4), marginTemp: +a.margin.temp.toFixed(4),
        resolvableTemp: a.resolvable.temp,
    }));
}
