/**
 * Experiment F4 - final controlled comparison (data for the manuscript)
 *
 * Three configurations, all other parameters identical:
 *   A confirm : confirmN=2, no vote                        (engineering baseline)
 *   B slope   : window slope >= threshold                  (degenerate control)
 *   C hybrid  : short-slope sliding marks + ratio >= rho   (proposed method)
 *
 * Plus a noise-bound scan validating the sigma_R <= 0.704 C limit.
 */
'use strict';
const fs = require('fs');
const { AlarmEngine } = require('D:/realtime-platform/realtime-platform-main/alarm-engine.js');
const std = require('D:/realtime-platform/realtime-platform-main/standards.js');

function makeRnd(seed) { let s = seed >>> 0; return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; }; }
const BASE = { pressure: 500, humidity: 50 };
const DUR = 300000;

const CFGS = {
  A_confirm: { voteEnabled: false, confirmN: 2 },
  B_slope:   { voteEnabled: true, voteSlopeMode: true, confirmN: 2, voteWindowMs: 45000 },
  C_hybrid:  { voteEnabled: true, voteSlopeMode: 'hybrid', confirmN: 2,
               voteWindowMs: 45000, voteRatio: 0.5, voteMinSamples: 2, slopeSpanMs: 20000 },
};

function noiseT(cfg, seed, sigma) {
  const e = new AlarmEngine(cfg); const rnd = makeRnd(seed); let g = rnd() * 2 - 1;
  for (let t = 0; t <= DUR; t += 1000) { g = g * 0.9 + (rnd() * 2 - 1) * 0.1; e.push({ t, ...BASE, temperature: 25 + g * sigma }); }
  return e.alarms.filter((a) => a.signal === 'temperature');
}
function spikeT(cfg, seed, period) {
  const e = new AlarmEngine(cfg); const rnd = makeRnd(seed); let g = rnd() * 2 - 1;
  for (let t = 0; t <= DUR; t += 1000) {
    g = g * 0.9 + (rnd() * 2 - 1) * 0.1;
    e.push({ t, ...BASE, temperature: 25 + g + ((t % period === period / 2) ? 70 : 0) });
  }
  return e.alarms.filter((a) => a.signal === 'temperature');
}
function rampT(cfg, seed, rate) {
  const e = new AlarmEngine(cfg); const rnd = makeRnd(seed);
  for (let t = 0; t <= DUR; t += 1000) {
    e.push({ t, ...BASE, temperature: 25 + (rate / 60) * (t / 1000) + (rnd() * 2 - 1) * 0.1, truthOnsetMs: 0 });
  }
  return e.alarms.filter((a) => a.signal === 'temperature');
}
function thrOnlyLat(seed, rate, dur) {
  const th = JSON.parse(JSON.stringify(std.ALARM_DEFAULTS));
  for (const k of Object.keys(th)) delete th[k].rocPerMin;
  const e = new AlarmEngine({ thresholds: th }); const rnd = makeRnd(seed);
  for (let t = 0; t <= dur; t += 1000) {
    e.push({ t, ...BASE, temperature: 25 + (rate / 60) * (t / 1000) + (rnd() * 2 - 1) * 0.1, truthOnsetMs: 0 });
  }
  return e.alarms.length ? e.alarms[0].t / 1000 : null;
}

const NT = 300, NS = 5, NOISE_SIGMA = 1.0;
const rows = [];

for (const name of Object.keys(CFGS)) {
  const cfg = CFGS[name];
  let nSum = 0, sSum = 0, sRoc = 0, sThr = 0;
  for (let k = 0; k < NT; k++) nSum += noiseT(cfg, 10000 + k, NOISE_SIGMA).length;
  for (let k = 0; k < NT; k++) {
    const a = spikeT(cfg, 20000 + k, 30000);
    sSum += a.length;
    sRoc += a.filter((x) => x.source === 'roc').length;
    sThr += a.filter((x) => x.source === 'threshold').length;
  }
  const lats = [];
  for (let k = 0; k < NS; k++) { const a = rampT(cfg, 30000 + k, 3); if (a.length) lats.push(a[0].t / 1000); }
  lats.sort((x, y) => x - y);
  rows.push({
    group: name,
    noise_alarms: nSum,
    noise_rate_per_h: +(nSum / NT / (DUR / 3600000)).toFixed(2),
    spike_alarms: sSum,
    spike_from_roc: sRoc,
    spike_from_threshold: sThr,
    ramp_latency_median_s: lats.length ? lats[Math.floor(lats.length / 2)] : 'MISSED',
    trials: NT,
  });
  const r = rows[rows.length - 1];
  console.log(`${name.padEnd(11)} noise=${String(nSum).padStart(5)} (${r.noise_rate_per_h}/h)  spike=${String(sSum).padStart(5)} (roc=${sRoc},thr=${sThr})  latency=${r.ramp_latency_median_s}`);
}

const baseSpike = rows[0].spike_alarms;
rows.forEach((r) => { r.spike_reduction_pct = baseSpike > 0 ? +((1 - r.spike_alarms / baseSpike) * 100).toFixed(1) : 0; });

const thrLat = thrOnlyLat(777, 3, 1800000);
const cLat = rows[2].ramp_latency_median_s;
console.log(`\nthreshold-only latency: ${thrLat} s`);
console.log(`hybrid vote latency   : ${cLat} s`);
console.log(`advance               : ${(thrLat - cLat).toFixed(0)} s`);

const sigmaW = [0.15, 0.22, 0.28, 0.45, 0.70, 0.95, 1.40, 1.78];
const bnd = [];
for (const sw of sigmaW) {
  let hit = 0;
  for (let k = 0; k < 50; k++) {
    const e = new AlarmEngine(CFGS.C_hybrid);
    const rnd = makeRnd(40000 + k);
    for (let t = 0; t <= DUR; t += 1000) e.push({ t, ...BASE, temperature: 25 + (rnd() * 2 - 1) * sw });
    if (e.alarms.filter((a) => a.signal === 'temperature').length > 0) hit++;
  }
  const sigR = Math.SQRT2 * sw;
  bnd.push({
    sigma_W_C: sw,
    sigma_R_theory: +sigR.toFixed(4),
    three_sigma: +(3 * sigR).toFixed(4),
    exceeds_0704: sigR * 3 > 0.704 ? 'YES' : 'NO',
    falseAlarm_trials_of_50: hit,
  });
  console.log(`sigma_W=${sw} -> sigma_R=${sigR.toFixed(4)}, 3sigma=${(3 * sigR).toFixed(4)} ${sigR * 3 > 0.704 ? '>0.704 UNUSABLE' : '<=0.704 usable'}  falseAlarm=${hit}/50`);
}

const OUT = 'D:/realtime-platform/论文实验数据/';
fs.writeFileSync(OUT + 'exp_F4_final.csv',
  '\uFEFF' + Object.keys(rows[0]).join(',') + '\n' + rows.map((r) => Object.values(r).join(',')).join('\n'), 'utf8');
fs.writeFileSync(OUT + 'exp_F4_noise.csv',
  '\uFEFF' + Object.keys(bnd[0]).join(',') + '\n' + bnd.map((r) => Object.values(r).join(',')).join('\n'), 'utf8');
fs.writeFileSync(OUT + 'exp_F4_latency.json',
  JSON.stringify({ threshold_only_s: thrLat, hybrid_vote_s: cLat, advance_s: +(thrLat - cLat).toFixed(0) }, null, 2), 'utf8');
console.log('\nwritten exp_F4_final.csv / exp_F4_noise.csv / exp_F4_latency.json');
