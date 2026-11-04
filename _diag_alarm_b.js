// 诊断：无噪声 + 单点尖峰，观察 AlarmEngine 行为
const { AlarmEngine } = require('./alarm-engine.js');
const eng = new AlarmEngine({ sigma: 1.0, lambda: 0.2, windowMin: 1.0, confirmN: 2, suppressMs: 0, prewarmMs: 15000 });
let n = 0;
for (let t = 0; t <= 200000; t += 1000) {
    const x = (t === 100000) ? 95 : 25;
    const ev = eng.push({ t, temperature: x });
    if (ev.length) { n++; console.log(`t=${t} 报警 ${ev.length} 条:`, JSON.stringify(ev)); }
}
console.log('总报警数:', n);
