// recompute_tab8.js —— 复算表8：告警引擎处理前后对比
'use strict';
const { AlarmEngine } = require('./alarm-engine.js');

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const BASE = { pressure: 500, humidity: 50 };

// 处理前：原始变化率判据（无 EWMA、无中值-变化率一致性对齐）——用 voteEnabled 且 slopeSpan 极短模拟“不一致”
function makeBefore() {
    return new AlarmEngine({
        voteEnabled: true, voteSlopeMode: 'hybrid', confirmN: 2,
        voteWindowMs: 90000, voteRatio: 0.5, voteMinSamples: 2,
        slopeSpanMs: 20000, medianOnly: false,   // 不做中值滤波一致性
    });
}
// 处理后：本文方法（EWMA 滑窗差分 + 阈值/变化率共用滤波序列）
function makeAfter() {
    return new AlarmEngine({
        voteEnabled: true, voteSlopeMode: 'hybrid', confirmN: 2,
        voteWindowMs: 90000, voteRatio: 0.5, voteMinSamples: 2,
        slopeSpanMs: 20000, medianOnly: true,
    });
}

function countNoise(engineFactory, trials, sigmaW) {
    let total = 0;
    for (let i = 0; i < trials; i++) {
        const e = engineFactory();
        const r = rng(100000 + i * 17);
        for (let t = 0; t <= 300000; t += 1000) {
            e.push({ t, ...BASE, temperature: 25 + gauss(r) * sigmaW, truthOnsetMs: 0 });
        }
        total += e.alarms.filter(a => a.signal === 'temperature').length;
    }
    return total;
}
function countSpike(engineFactory, trials) {
    let total = 0, rocTotal = 0;
    for (let i = 0; i < trials; i++) {
        const e = engineFactory();
        const r = rng(200000 + i * 17); let g = r() * 2 - 1;
        for (let t = 0; t <= 300000; t += 1000) {
            g = g * 0.9 + (r() * 2 - 1) * 0.1;
            if (t % 30000 === 15000) {
                for (let k = 0; k < 5; k++) e.push({ t: t + k, ...BASE, temperature: 25 + g + 70, truthOnsetMs: 0 });
            } else {
                e.push({ t, ...BASE, temperature: 25 + g, truthOnsetMs: 0 });
            }
        }
        const al = e.alarms.filter(a => a.signal === 'temperature');
        total += al.length;
        rocTotal += al.filter(a => a.source === 'roc' || a.criterion === 'roc').length;
    }
    return { total, rocTotal };
}

console.log('=== 表8 复算（200 次试验 × 300 s）===');
console.log('纯噪声 σW=1.0 ℃:');
const b = countNoise(makeBefore, 200, 1.0);
const a = countNoise(makeAfter, 200, 1.0);
console.log('  处理前 =', b, '条  (' + (b / 200 / 300 * 3600).toFixed(1) + ' 次/h)   论文 1 969 条（78.8 次/h）');
console.log('  处理后 =', a, '条                              论文 0 条');
console.log('单点尖峰（1750 个等价）:');
const sb = countSpike(makeBefore, 200);
const sa = countSpike(makeAfter, 200);
console.log('  处理前 =', sb.total, '条   论文 2 230 条');
console.log('  其中变化率通道 =', sb.rocTotal, '条   论文 2 156 条');
console.log('  处理后 =', sa.total, '条   论文 45 条');
console.log('  其中变化率通道 =', sa.rocTotal, '条   论文 6 条');
