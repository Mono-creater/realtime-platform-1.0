// verify_alarm.js —— 纯噪声误报复核与 σ 扫描（论文 P115 / P117、§4.4 / 式(12)）
// 工况 A：15 s 冷启动保护（P117：差分基准不得早于引擎启动后 15 s）启用前后的纯噪声误报；
// 工况 B：LegacyEngine（变化率通道读原始样本的旧实现）与 1.0 平台的回归对照；
// 噪声边界：σ 扫描与论文 P115 的 0 / 62.5% / 95.5% 三行比对。
'use strict';
const { AlarmEngine } = require('../alarm-engine.js');
const { deltaMin } = require('../ewma-trend.js');

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function median3(a, b, c) { return [a, b, c].sort((x, y) => x - y)[1]; }

/**
 * 处理前的告警引擎（论文 §2.4 所述"滤波不一致"的旧实现）：
 *   阈值通道读中值滤波后的量值；变化率通道直接读【原始样本】算差分。
 */
class LegacyEngine {
    constructor({ rocThr = 2.0, W = 60000, confirmN = 2, tempHigh = 80 } = {}) {
        this.rocThr = rocThr; this.W = W; this.confirmN = confirmN; this.tempHigh = tempHigh;
        this.hist = []; this.medBuf = [];
        this.thrCount = 0; this.rocCount = 0;
        this.alarms = [];
    }
    push(t, x) {
        this.medBuf.push(x); if (this.medBuf.length > 3) this.medBuf.shift();
        const med = this.medBuf.length === 3 ? median3(this.medBuf[0], this.medBuf[1], this.medBuf[2]) : x;
        this.hist.push({ t, x });                      // 原始样本
        if (this.hist.length > 200000) this.hist.shift();

        // 阈值通道：中值滤波后判越限（连续 n 点）
        this.thrCount = med > this.tempHigh ? this.thrCount + 1 : 0;
        if (this.thrCount >= this.confirmN) this.alarms.push({ t, src: 'threshold' });

        // 变化率通道：原始样本差分（未与阈值通道共用滤波序列）
        const ref = this.hist.find((h) => t - h.t >= this.W);
        if (!ref) return;
        const roc = (x - ref.x) / ((t - ref.t) / 60000);
        this.rocCount = roc >= this.rocThr ? this.rocCount + 1 : 0;
        if (this.rocCount >= this.confirmN) this.alarms.push({ t, src: 'roc', roc });
    }
}

const TRIALS = 300, DUR = 300, DT = 1000, SIGMA = 1.0, MU = 25;

// ---------- 工况 A：纯噪声（无异常）----------
// P117：未启用冷启动保护时 300 次 × 300 s 伪告警 7~8 条，集中于 t≈61~63 s（EWMA 冷启动
//      未收敛期首批差分方差偏大）；启用 15 s 保护后 0 条（P115：200 次 × 300 s → 0 条，
//      此处以 300 次更严口径复核）。
console.log('==== 纯噪声误报复核（论文 P115 / P117）====\n');
let offTotal = 0, onTotal = 0;
for (let k = 0; k < TRIALS; k++) {
    const r = rng(20000 + k * 7);
    const ngOff = new AlarmEngine({ sigma: SIGMA, lambda: 0.2, windowMin: 1.0, confirmN: 2, suppressMs: 0 });
    const ngOn = new AlarmEngine({ sigma: SIGMA, lambda: 0.2, windowMin: 1.0, confirmN: 2, suppressMs: 0, coldStartProtectMs: 15000 });
    for (let t = 0; t <= DUR * 1000; t += DT) {
        const x = MU + gauss(r) * SIGMA;
        ngOff.push({ t, temperature: x });
        ngOn.push({ t, temperature: x });
    }
    offTotal += ngOff.alarms.length;
    onTotal += ngOn.alarms.length;
}
console.log(`[工况 A] 纯噪声（${TRIALS} 次 × ${DUR} s，σ=${SIGMA} ℃，无异常）`);
console.log(`  冷启动保护关闭: ${offTotal} 条  [论文 P117: 7~8 条，集中于 t≈61~63 s]${offTotal >= 6 && offTotal <= 9 ? '  [OK]' : '  [!!]'}`);
console.log(`  冷启动保护开启: ${onTotal} 条  [论文 P115: 0 条（200 次 × 300 s 口径，此处 300 次更严）]${onTotal === 0 ? '  [OK]' : '  [!!]'}`);

// ---------- 工况 B：注入单点尖峰（回归对照）----------
// 处理前口径（LegacyEngine）与论文 §2.4 P68 "142 条中 106 条（74.6%）来自变化率通道" 一致
//（固定种子精确复现）。处理后口径为平台回归基线；论文表9 的尖峰对照为另一口径
//（1 750 个 +8 ℃ 尖峰 → 91 条），论文侧脚本（D:/驭弓大师/10_创新升级/）未归档，待收录复现。
const SPIKES_PER_TRIAL = Math.round(1750 / TRIALS);   // ≈6 个/次
let lgB = 0, ngB = 0, lgRoc = 0, ngRoc = 0;
for (let k = 0; k < TRIALS; k++) {
    const r = rng(30000 + k * 11);
    const lg = new LegacyEngine();
    const ng = new AlarmEngine({ sigma: SIGMA, lambda: 0.2, windowMin: 1.0, confirmN: 2, suppressMs: 0 });
    const spikeAt = new Set();
    while (spikeAt.size < SPIKES_PER_TRIAL) spikeAt.add(Math.floor(r() * (DUR - 1)) + 1);
    for (let t = 0; t <= DUR * 1000; t += DT) {
        let x = MU + gauss(r) * SIGMA;
        if (spikeAt.has(t / 1000)) x = 95;                 // 单点尖峰 95 ℃
        lg.push(t, x);
        ng.push({ t, temperature: x });
    }
    lgB += lg.alarms.length; ngB += ng.alarms.length;
    lgRoc += lg.alarms.filter((a) => a.src === 'roc').length;
    ngRoc += ng.alarms.filter((a) => a.source === 'roc').length;
}
console.log(`\n[工况 B] 注入单点尖峰 ${SPIKES_PER_TRIAL * TRIALS} 个（${TRIALS} 次 × ${SPIKES_PER_TRIAL} 个）`);
console.log(`  处理前: ${lgB} 条  [论文 §2.4: 142 条]${lgB === 142 ? '  [OK]' : '  [!!]'}`);
console.log(`  其中变化率通道 —— 处理前: ${lgRoc} 条  [论文 §2.4: 106 条（74.6%）]${lgRoc === 106 ? '  [OK]' : '  [!!]'}`);
console.log(`  处理后: ${ngB} 条  [平台回归基线（论文表9 为另一口径：+8 ℃ 尖峰 → 91 条，待论文侧脚本收录）]`);
console.log(`  其中变化率通道 —— 处理后: ${ngRoc} 条`);

// ---------- 噪声边界（σ 扫描，论文 §4.4 / P115）----------
// 启用 15 s 冷启动保护（P115 为误报率评估类试验口径）。固定种子 LCG（确定性）；
// σ=2.0 为刀口工况（L = 2.12σr），复算须同种子同口径。
console.log('\n==== 噪声边界（论文 §4.4 / P115，启用 15 s 冷启动保护）====');
for (const sg of [1.0, 2.0, 2.5]) {
    let cnt = 0;
    for (let k = 0; k < 200; k++) {
        const r = rng(40000 + k * 3 + Math.round(sg * 10));
        const ng = new AlarmEngine({ sigma: sg, lambda: 0.2, windowMin: 1.0, confirmN: 2, suppressMs: 0, noiseCheck: false, coldStartProtectMs: 15000 });
        let hit = false;
        for (let t = 0; t <= DUR * 1000; t += DT) {
            if (ng.push({ t, temperature: MU + gauss(r) * sg }).length) { hit = true; break; }
        }
        if (hit) cnt += 1;
    }
    const dm = deltaMin(sg, 0.2, 1.0).toFixed(3);
    const [target, tol] = sg === 1.0 ? [0, 0] : sg === 2.0 ? [125, 10] : [191, 6];
    const ok = Math.abs(cnt - target) <= tol;
    console.log(`  σ=${sg.toFixed(1)} ℃: δmin=${dm}，200 次试验中 ${cnt} 次出现告警（${(cnt / 200 * 100).toFixed(1)}%）  [论文 P115: ${target}/200（${(target / 2).toFixed(1)}%）]${ok ? '  [OK]' : '  [!!]'}`);
}
