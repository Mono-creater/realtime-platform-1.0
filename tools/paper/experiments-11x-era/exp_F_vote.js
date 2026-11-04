/**
 * 实验 F · 变化率通道时间窗持续性投票的效果验证
 *
 * 对照三组配置（其余参数完全相同，仅投票机制不同）：
 *   legacy —— 变化率读原始序列（未经中值滤波），模拟"滤波不一致"
 *   v2     —— 变化率改读滤波序列，但仍用"连续 n 点"确认
 *   vote   —— 变化率读滤波序列 + 时间窗持续性投票（本文方法）
 *
 * 全部调用平台真实实现（alarm-engine.js），非另写模型。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { AlarmEngine } = require('D:/realtime-platform/realtime-platform-main/alarm-engine.js');

const OUT = 'D:/realtime-platform/论文实验数据';

// 固定种子伪随机数，保证可复现
function makeRnd(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
}

const BASE = { pressure: 500, humidity: 50 };

/** 场景 1：纯噪声（25 ℃ 基准，σ≈1 ℃，无异常） */
function noiseRun(cfg, seed, dur = 300000) {
  const e = new AlarmEngine(cfg);
  const rnd = makeRnd(seed);
  let g = (rnd() * 2 - 1);
  for (let t = 0; t <= dur; t += 1000) {
    g = g * 0.9 + (rnd() * 2 - 1) * 0.1;
    e.push({ t, ...BASE, temperature: 25 + g });
  }
  return e;
}

/** 场景 2：注入单点尖峰（幅值 +70 ℃，每 30 s 一次） */
function spikeRun(cfg, seed, dur = 300000, period = 30000) {
  const e = new AlarmEngine(cfg);
  const rnd = makeRnd(seed);
  let g = (rnd() * 2 - 1);
  for (let t = 0; t <= dur; t += 1000) {
    g = g * 0.9 + (rnd() * 2 - 1) * 0.1;
    const spike = (t % period === period / 2) ? 70 : 0;
    e.push({ t, ...BASE, temperature: 25 + g + spike });
  }
  return e;
}

/** 场景 3：缓变劣化 3 ℃/min，考察发现时延 */
function rampRun(cfg, seed, rate = 3, dur = 180000) {
  const e = new AlarmEngine(cfg);
  const rnd = makeRnd(seed);
  for (let t = 0; t <= dur; t += 1000) {
    const noise = (rnd() * 2 - 1) * 0.1;
    e.push({ t, ...BASE, temperature: 25 + (rate / 60) * (t / 1000) + noise, truthOnsetMs: 0 });
  }
  const first = e.alarms[0];
  return { engine: e, latencyS: first ? first.t / 1000 : null, source: first ? first.source : null };
}

/** 场景 4：纯阈值判据（关闭 ROC 通道）作为时延对照 */
function thresholdOnlyRun(seed, rate = 3, dur = 900000) {
  const th = JSON.parse(JSON.stringify(require('D:/realtime-platform/realtime-platform-main/standards.js').ALARM_DEFAULTS));
  for (const k of Object.keys(th)) delete th[k].rocPerMin;
  const e = new AlarmEngine({ thresholds: th });
  const rnd = makeRnd(seed);
  for (let t = 0; t <= dur; t += 1000) {
    const noise = (rnd() * 2 - 1) * 0.1;
    e.push({ t, ...BASE, temperature: 25 + (rate / 60) * (t / 1000) + noise, truthOnsetMs: 0 });
  }
  const first = e.alarms[0];
  return first ? first.t / 1000 : null;
}

const CFG = {
  // 变化率读原始序列：medianOnly 仍为 true（阈值通道用中值），但 ROC 用原始样本。
  // 平台实现中 ROC 与滤波同源，故此处以 voteEnabled=false + confirmN=1 近似"未加确认"
  legacy: { voteEnabled: false, confirmN: 1 },
  v2:     { voteEnabled: false, confirmN: 2 },
  vote:   { voteEnabled: true,  confirmN: 2, voteWindowMs: 90000, voteRatio: 0.5, voteMinSamples: 2 },
};

const rows = [];
const N_TRIALS = 300;

for (const [name, cfg] of Object.entries(CFG)) {
  let noiseAlarms = 0, spikeAlarms = 0, spikeRoc = 0, spikeThr = 0, trials = 0;
  for (let k = 0; k < N_TRIALS; k++) {
    const n = noiseRun(cfg, 1000 + k);
    noiseAlarms += n.alarms.filter((a) => a.signal === 'temperature').length;
    const s = spikeRun(cfg, 2000 + k);
    const ta = s.alarms.filter((a) => a.signal === 'temperature');
    spikeAlarms += ta.length;
    spikeRoc += ta.filter((a) => a.source === 'roc').length;
    spikeThr += ta.filter((a) => a.source === 'threshold').length;
    trials++;
  }
  rows.push({
    组别: name,
    纯噪声告警数: noiseAlarms,
    纯噪声误报率_次每小时: +(noiseAlarms / trials / (300 / 3600)).toFixed(2),
    尖峰温度告警数: spikeAlarms,
    其中变化率通道: spikeRoc,
    其中阈值通道: spikeThr,
    试验次数: trials,
  });
  console.log(`${name.padEnd(8)} 纯噪声=${noiseAlarms}  尖峰=${spikeAlarms} (roc=${spikeRoc}, thr=${spikeThr})`);
}

// 缓变时延
const thrLat = thresholdOnlyRun(777);
const rampVote = rampRun(CFG.vote, 777);
const rampV2 = rampRun(CFG.v2, 777);
console.log(`\n纯阈值判据发现时延: ${thrLat} s`);
console.log(`连续确认(v2)发现时延: ${rampV2.latencyS} s (src=${rampV2.source})`);
console.log(`时间窗投票发现时延: ${rampVote.latencyS} s (src=${rampVote.source})`);

const latency = {
  纯阈值判据_s: thrLat,
  连续确认_s: rampV2.latencyS,
  时间窗投票_s: rampVote.latencyS,
  投票相对阈值提前_s: (thrLat !== null && rampVote.latencyS !== null) ? +(thrLat - rampVote.latencyS).toFixed(0) : null,
  投票相对连续确认提前_s: (rampV2.latencyS !== null && rampVote.latencyS !== null) ? +(rampV2.latencyS - rampVote.latencyS).toFixed(0) : null,
};

fs.writeFileSync(path.join(OUT, 'exp_F_vote.csv'),
  '\uFEFF' + Object.keys(rows[0]).join(',') + '\n' +
  rows.map((r) => Object.values(r).join(',')).join('\n'), 'utf8');
fs.writeFileSync(path.join(OUT, 'exp_F_latency.json'),
  JSON.stringify(latency, null, 2), 'utf8');
console.log('\nwritten exp_F_vote.csv / exp_F_latency.json');
