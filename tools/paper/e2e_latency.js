/**
 * e2e_latency.js —— 图6 端到端时延重新生成（论文12.7 口径）
 *
 * 模型（对应论文图 6 与 L1460-1464）：
 *   - 温度阶跃 25 → 85 ℃（越限 80 ℃），PLC 以 0.1 s 采样、10 点滑动均值判定；
 *   - 边缘网关按轮询周期 P ∈ {0.5, 1, 2, 5, 10} s 读取边缘判定结果，
 *     端到端时延 = 滑动窗建立（约 1.0 s）+ 首个越过判定后的轮询相位等待；
 *   - 平台引擎行（2 s 轮询）：边缘检出（均值 2.0 s）→ 下一平台轮询上传（均值 +1.0 s）
 *     → 引擎评估与推送（1.5 s 告警时延，论文 P97；+0.5 s 推送）→ 均值 5.0 s；
 *   - 每工况 20 000 次独立试验（阶跃相位与轮询相位均匀随机），输出均值与 95 分位。
 * 全部固定种子，可复现。输出即论文图 6 的新权威数值。
 */
'use strict';

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }

const N_TRIALS = 20000, STEP_FROM = 25, STEP_TO = 85, THRESHOLD = 80, N_AVG = 10, DT = 0.1;

/**
 * 单次试验：采样为绝对 0.1 s 网格；阶跃相位 s ∈ (0, 0.1)（首个阶跃后样本前）；
 * 滑窗第 10 个阶跃后样本在绝对 1.0 s 落下（9 样本均值 79 < 80，10 样本均值 85 ≥ 80）；
 * 轮询相位 φ ∈ (0, P)。端到端时延 = 首个 ≥ 1.0 s 的轮询时刻 − 阶跃时刻。
 */
function edgeLatency(s, phi, P) {
    const tReadyAbs = 1.0;                       // 10 点滑窗建立时刻（绝对网格）
    const j = Math.max(0, Math.ceil((tReadyAbs - phi) / P));
    const tPoll = phi + j * P;                   // 首个越过判定后的轮询（绝对）
    return tPoll - s;                            // 端到端时延（相对阶跃）
}

console.log('=== 图6 端到端时延（20 000 次/工况；边缘网关 10 点滑窗 + 轮询相位） ===');
console.log('  轮询周期 | 均值(s) | 95分位(s)');
const PS = [0.5, 1, 2, 5, 10];
const rows = [];
for (const P of PS) {
    const r = rng(20261018 + 6 + Math.round(P * 100));
    const lats = [];
    for (let i = 0; i < N_TRIALS; i++) {
        const s = r() * DT;                     // 阶跃在首采样间隔内的相位
        const phi = r() * P;                    // 轮询相位
        lats.push(edgeLatency(s, phi, P));
    }
    lats.sort((a, b) => a - b);
    const mean = lats.reduce((a, b) => a + b, 0) / N_TRIALS;
    const p95 = lats[Math.floor(N_TRIALS * 0.95)];
    rows.push({ P, mean, p95 });
    console.log(`  ${String(P).padStart(6)} s | ${mean.toFixed(2).padStart(6)} | ${p95.toFixed(2).padStart(7)}`);
}

console.log('\n=== 平台引擎行（2 s 轮询）：边缘检出均值 2.0 s + 上传下一轮询均值 1.0 s + 引擎 1.5 s + 推送 0.5 s ===');
console.log('  均值 = 5.00 s');
