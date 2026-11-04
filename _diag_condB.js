// 诊断工况 B：复刻 verify_alarm.js 的随机逻辑，找出 440 条的来源
const { AlarmEngine } = require('./alarm-engine.js');
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const TRIALS = 300, DUR = 300, DT = 1000, SIGMA = 1.0, MU = 25;
const SPIKES_PER_TRIAL = Math.round(1750 / TRIALS);
let total = 0, totalNoSpike = 0;
const detail = [];
for (let k = 0; k < TRIALS; k++) {
    const r = rng(30000 + k * 11);
    const ng = new AlarmEngine({ sigma: SIGMA, lambda: 0.2, windowMin: 1.0, confirmN: 2, suppressMs: 0, prewarmMs: 15000 });
    const spikeAt = new Set();
    while (spikeAt.size < SPIKES_PER_TRIAL) spikeAt.add(Math.floor(r() * (DUR - 1)) + 1);
    const evs = [];
    for (let t = 0; t <= DUR * 1000; t += DT) {
        let x = MU + gauss(r) * SIGMA;
        if (spikeAt.has(t / 1000)) x = 95;
        const ev = ng.push({ t, temperature: x });
        if (ev.length) evs.push(...ev.map((e) => ({ t: e.t, source: e.source, roc: e.roc, value: e.value })));
    }
    total += evs.length;
    if (evs.length) detail.push({ k, spikes: [...spikeAt].sort((a, b) => a - b), n: evs.length, sample: evs.slice(0, 4) });
    // 同种子、无尖峰对照
    const r2 = rng(30000 + k * 11);
    const ng2 = new AlarmEngine({ sigma: SIGMA, lambda: 0.2, windowMin: 1.0, confirmN: 2, suppressMs: 0, prewarmMs: 15000 });
    const spikeAt2 = new Set();
    while (spikeAt2.size < SPIKES_PER_TRIAL) spikeAt2.add(Math.floor(r2() * (DUR - 1)) + 1);
    for (let t = 0; t <= DUR * 1000; t += DT) {
        const x = MU + gauss(r2) * SIGMA;   // 不加尖峰
        totalNoSpike += ng2.push({ t, temperature: x }).length;
    }
}
console.log('带尖峰总数:', total, ' 无尖峰对照总数:', totalNoSpike);
console.log('有告警的试验数:', detail.length, '/', TRIALS);
console.log('--- 前 8 个试验详情 ---');
for (const d of detail.slice(0, 8)) console.log(JSON.stringify(d));
