/**
 * 实验 F3 · 窗级斜率模式下 (Tvote, ρ, ρ_major) 三维标定
 * 目标：在保持误报为零的前提下最小化缓变发现时延。
 */
'use strict';
const fs = require('fs');
const { AlarmEngine } = require('D:/realtime-platform/realtime-platform-main/alarm-engine.js');

function makeRnd(seed) { let s = seed >>> 0; return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; }; }
const BASE = { pressure: 500, humidity: 50 };

function noiseCount(cfg, seed, dur = 300000) {
  const e = new AlarmEngine(cfg); const rnd = makeRnd(seed); let g = rnd() * 2 - 1;
  for (let t = 0; t <= dur; t += 1000) { g = g * 0.9 + (rnd() * 2 - 1) * 0.1; e.push({ t, ...BASE, temperature: 25 + g }); }
  return e.alarms.filter((a) => a.signal === 'temperature').length;
}
function spikeCount(cfg, seed, dur = 300000, period = 30000) {
  const e = new AlarmEngine(cfg); const rnd = makeRnd(seed); let g = rnd() * 2 - 1;
  for (let t = 0; t <= dur; t += 1000) {
    g = g * 0.9 + (rnd() * 2 - 1) * 0.1;
    e.push({ t, ...BASE, temperature: 25 + g + ((t % period === period / 2) ? 70 : 0) });
  }
  return e.alarms.filter((a) => a.signal === 'temperature').length;
}
function rampLat(cfg, seed, rate = 3, dur = 300000) {
  const e = new AlarmEngine(cfg); const rnd = makeRnd(seed);
  for (let t = 0; t <= dur; t += 1000) {
    e.push({ t, ...BASE, temperature: 25 + (rate / 60) * (t / 1000) + (rnd() * 2 - 1) * 0.1, truthOnsetMs: 0 });
  }
  return e.alarms.length ? e.alarms[0].t / 1000 : null;
}

const NT = 200;
const rows = [];

for (const T of [20000, 30000, 45000, 60000]) {
  for (const rho of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    const cfg = { voteEnabled: true, voteSlopeMode: 'hybrid', confirmN: 2,
                  voteWindowMs: T, voteRatio: rho, voteMinSamples: 2, slopeSpanMs: 20000 };
    let noise = 0, spike = 0;
    for (let k = 0; k < NT; k++) { noise += noiseCount(cfg, 3000 + k); spike += spikeCount(cfg, 4000 + k); }
    const lat = [];
    for (let k = 0; k < 5; k++) { const l = rampLat(cfg, 5000 + k); if (l !== null) lat.push(l); }
    lat.sort((a, b) => a - b);
    const med = lat.length ? lat[Math.floor(lat.length / 2)] : null;
    rows.push({ Tvote_s: T / 1000, rho, 纯噪声误报: noise, 尖峰误报: spike,
                缓变时延_s: med === null ? '漏检' : med, 误报合计: noise + spike });
    console.log(`Tvote=${String(T/1000).padStart(2)}s ρ=${rho}  噪声=${String(noise).padStart(4)} 尖峰=${String(spike).padStart(4)} 时延=${med === null ? '漏检' : med + 's'}`);
  }
}
fs.writeFileSync('D:/realtime-platform/论文实验数据/exp_F3_slope_workpoint.csv',
  '\uFEFF' + Object.keys(rows[0]).join(',') + '\n' + rows.map((r) => Object.values(r).join(',')).join('\n'), 'utf8');
console.log('\nwritten exp_F3_slope_workpoint.csv');
