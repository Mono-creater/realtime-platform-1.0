/**
 * 实验 F2 · 投票窗工作点标定
 * 在 (Tvote, ρ) 网格上扫描，量化误报抑制与发现时延的权衡，
 * 为论文给出可辩护的工作点选择依据。
 */
'use strict';
const fs = require('fs');
const { AlarmEngine } = require('D:/realtime-platform/realtime-platform-main/alarm-engine.js');

function makeRnd(seed) { let s = seed >>> 0; return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; }; }
const BASE = { pressure: 500, humidity: 50 };

function noiseRun(cfg, seed, dur = 300000) {
  const e = new AlarmEngine(cfg);
  const rnd = makeRnd(seed);
  let g = (rnd() * 2 - 1);
  for (let t = 0; t <= dur; t += 1000) {
    g = g * 0.9 + (rnd() * 2 - 1) * 0.1;
    e.push({ t, ...BASE, temperature: 25 + g });
  }
  return e.alarms.filter((a) => a.signal === 'temperature').length;
}

function spikeRun(cfg, seed, dur = 300000, period = 30000) {
  const e = new AlarmEngine(cfg);
  const rnd = makeRnd(seed);
  let g = (rnd() * 2 - 1);
  for (let t = 0; t <= dur; t += 1000) {
    g = g * 0.9 + (rnd() * 2 - 1) * 0.1;
    const spike = (t % period === period / 2) ? 70 : 0;
    e.push({ t, ...BASE, temperature: 25 + g + spike });
  }
  return e.alarms.filter((a) => a.signal === 'temperature').length;
}

function rampLatency(cfg, seed, rate = 3, dur = 300000) {
  const e = new AlarmEngine(cfg);
  const rnd = makeRnd(seed);
  for (let t = 0; t <= dur; t += 1000) {
    const noise = (rnd() * 2 - 1) * 0.1;
    e.push({ t, ...BASE, temperature: 25 + (rate / 60) * (t / 1000) + noise, truthOnsetMs: 0 });
  }
  return e.alarms.length ? e.alarms[0].t / 1000 : null;
}

const NT = 200;
const rows = [];

for (const Tvote of [30000, 60000, 90000]) {
  for (const rho of [0.3, 0.4, 0.5, 0.6]) {
    const cfg = { voteEnabled: true, confirmN: 2, voteWindowMs: Tvote, voteRatio: rho, voteMinSamples: 2 };
    let noise = 0, spike = 0;
    for (let k = 0; k < NT; k++) { noise += noiseRun(cfg, 3000 + k); spike += spikeRun(cfg, 4000 + k); }
    const lat = [];
    for (let k = 0; k < 5; k++) { const l = rampLatency(cfg, 5000 + k); if (l !== null) lat.push(l); }
    const latMed = lat.sort((a, b) => a - b)[Math.floor(lat.length / 2)];
    rows.push({
      Tvote_s: Tvote / 1000, rho: rho,
      纯噪声误报数: noise, 尖峰误报数: spike,
      缓变发现时延_s: latMed === undefined ? null : latMed,
      误报合计: noise + spike,
    });
    console.log(`Tvote=${Tvote/1000}s ρ=${rho}  噪声=${noise} 尖峰=${spike} 时延=${latMed}s`);
  }
}

// 基线：连续确认（无投票）
{
  const cfg = { voteEnabled: false, confirmN: 2 };
  let noise = 0, spike = 0;
  for (let k = 0; k < NT; k++) { noise += noiseRun(cfg, 3000 + k); spike += spikeRun(cfg, 4000 + k); }
  const lat = [];
  for (let k = 0; k < 5; k++) { const l = rampLatency(cfg, 5000 + k); if (l !== null) lat.push(l); }
  const latMed = lat.sort((a, b) => a - b)[Math.floor(lat.length / 2)];
  rows.unshift({
    Tvote_s: '—', rho: '—', 纯噪声误报数: noise, 尖峰误报数: spike,
    缓变发现时延_s: latMed === undefined ? null : latMed, 误报合计: noise + spike,
  });
  console.log(`基线(连续确认)   噪声=${noise} 尖峰=${spike} 时延=${latMed}s`);
}

fs.writeFileSync('D:/realtime-platform/论文实验数据/exp_F2_workpoint.csv',
  '\uFEFF' + Object.keys(rows[0]).join(',') + '\n' +
  rows.map((r) => Object.values(r).join(',')).join('\n'), 'utf8');
console.log('\nwritten exp_F2_workpoint.csv');
