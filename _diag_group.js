// 分组统计：孤立单点尖峰 vs 含相邻尖峰对（间距<=2s）
const { AlarmEngine } = require('./alarm-engine.js');
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function median3(a, b, c) { return [a, b, c].sort((x, y) => x - y)[1]; }
class LegacyEngine {
    constructor({ rocThr = 2.0, W = 60000, confirmN = 2, tempHigh = 80 } = {}) {
        this.rocThr = rocThr; this.W = W; this.confirmN = confirmN; this.tempHigh = tempHigh;
        this.hist = []; this.medBuf = []; this.thrCount = 0; this.rocCount = 0; this.alarms = [];
    }
    push(t, x) {
        this.medBuf.push(x); if (this.medBuf.length > 3) this.medBuf.shift();
        const med = this.medBuf.length === 3 ? median3(this.medBuf[0], this.medBuf[1], this.medBuf[2]) : x;
        this.hist.push({ t, x }); if (this.hist.length > 200000) this.hist.shift();
        this.thrCount = med > this.tempHigh ? this.thrCount + 1 : 0;
        if (this.thrCount >= this.confirmN) this.alarms.push({ t, src: 'threshold' });
        const ref = this.hist.find((h) => t - h.t >= this.W);
        if (!ref) return;
        const roc = (x - ref.x) / ((t - ref.t) / 60000);
        this.rocCount = roc >= this.rocThr ? this.rocCount + 1 : 0;
        if (this.rocCount >= this.confirmN) this.alarms.push({ t, src: 'roc', roc });
    }
}
const TRIALS = 300, DUR = 300, DT = 1000, SIGMA = 1.0, MU = 25;
const SPIKES_PER_TRIAL = Math.round(1750 / TRIALS);
let isoLg = 0, isoNg = 0, adjLg = 0, adjNg = 0, adjTrials = 0, isoTrials = 0;
let isoLgRoc = 0, adjLgRoc = 0, adjNgRoc = 0;
let allAdjHaveAlarm = true, allIsoNoAlarm = true;
for (let k = 0; k < TRIALS; k++) {
    const r = rng(30000 + k * 11);
    const lg = new LegacyEngine();
    const ng = new AlarmEngine({ sigma: SIGMA, lambda: 0.2, windowMin: 1.0, confirmN: 2, suppressMs: 0, prewarmMs: 15000 });
    const spikeAt = new Set();
    while (spikeAt.size < SPIKES_PER_TRIAL) spikeAt.add(Math.floor(r() * (DUR - 1)) + 1);
    const sp = [...spikeAt].sort((a, b) => a - b);
    let adjacent = false;
    for (let i = 1; i < sp.length; i++) if (sp[i] - sp[i - 1] <= 2) adjacent = true;
    for (let t = 0; t <= DUR * 1000; t += DT) {
        let x = MU + gauss(r) * SIGMA;
        if (spikeAt.has(t / 1000)) x = 95;
        lg.push(t, x);
        ng.push({ t, temperature: x });
    }
    if (adjacent) {
        adjTrials++; adjLg += lg.alarms.length; adjNg += ng.alarms.length;
        adjLgRoc += lg.alarms.filter((a) => a.src === 'roc').length;
        adjNgRoc += ng.alarms.filter((a) => a.source === 'roc').length;
        if (ng.alarms.length === 0) allAdjHaveAlarm = false;
    } else {
        isoTrials++; isoLg += lg.alarms.length; isoNg += ng.alarms.length;
        isoLgRoc += lg.alarms.filter((a) => a.src === 'roc').length;
        if (ng.alarms.length !== 0) allIsoNoAlarm = false;
    }
}
console.log(`总投资: 处理前 ${adjLg + isoLg} 条 / 处理后 ${adjNg + isoNg} 条`);
console.log(`孤立单点试验 ${isoTrials} 次: 处理前 ${isoLg} 条（其中 roc ${isoLgRoc}）→ 处理后 ${isoNg} 条  [isolated 全零=${allIsoNoAlarm}]`);
console.log(`含相邻对试验 ${adjTrials} 次: 处理前 ${adjLg} 条（其中 roc ${adjLgRoc}）→ 处理后 ${adjNg} 条（其中 roc ${adjNgRoc}）  [相邻试验全部有告警=${allAdjHaveAlarm}]`);
