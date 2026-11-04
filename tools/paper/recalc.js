/**
 * recalc.js —— 论文表6/表7/表8 数据重算（统一口径，可复现）
 *
 * 背景：论文《双包上报协议与告警运维闭环》中表6/7/8 的数值与其配套实验脚本
 * （R5/R6）在"观测窗口长度、噪声模型、投票工作点"三处口径不统一，导致
 * 数字不可复现。本脚本用修复后的模块（05_代码优化/）+ 明确口径重新计算，
 * 作为论文打磨版的权威数据来源。
 *
 * 口径：
 *  - 表6 丢包率：独立丢包信道（iid），序号回绕修正（mod 65535），
 *    每试验 5000 帧（2 s 轮询约 2.8 h），200 次独立试验；
 *  - 表7 误报：真实高斯白噪声（非 AR(1)），温度噪声标准差 σ_W，
 *    本文方法 T=90 s / ρ=50%（hybrid 短窗滑窗投票），300 s × N 次试验；
 *  - 表8 缓变时延：白噪声 σ=0.3 ℃ 叠加，本文方法 T=90 s，观测上限 3600 s。
 *
 * 运行：node recalc.js（工作目录任意，依赖 05_代码优化/ 下的修复模块）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const P = './';
const { AlarmEngine } = require(P + 'alarm-engine.js');
const { LinkMonitor } = require(P + 'link-monitor.js');
const std = require(P + 'standards.js');

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const BASE = { pressure: 500, humidity: 50 };
const CFG = { voteEnabled: true, voteSlopeMode: 'hybrid', confirmN: 2, voteWindowMs: 90000, voteRatio: 0.5, voteMinSamples: 2, slopeSpanMs: 20000 };
const OUT = __dirname;
function dump(name, rows) {
    const keys = Object.keys(rows[0]);
    const csv = '\uFEFF' + keys.join(',') + '\n' + rows.map((r) => keys.map((k) => {
        const v = r[k]; return typeof v === 'string' && /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(',')).join('\n');
    fs.writeFileSync(path.join(OUT, name), csv, 'utf8');
}

/* ---------- 表6 丢包率估计精度 ---------- */
console.log('=== 表6 丢包率估计精度（独立丢包，mod 65535，5000 帧/试验 × 200 次）===');
const t6 = [];
for (const truth of [0.01, 0.05, 0.10, 0.25, 0.50]) {
    const est = [];
    for (let k = 0; k < 200; k++) {
        const r = rng(7000 + k * 13 + Math.round(truth * 1000));
        const lm = new LinkMonitor();
        for (let i = 0; i < 5000; i++) { if (r() < truth) continue; lm.onPacket({ t: i * 1000, seq: (i % 65535) + 1 }); }
        est.push(lm.stats().lossRate * 100);
    }
    const mean = est.reduce((a, b) => a + b, 0) / est.length;
    const sd = Math.sqrt(est.reduce((a, b) => a + (b - mean) ** 2, 0) / (est.length - 1));
    const mae = est.reduce((a, b) => a + Math.abs(b - truth * 100), 0) / est.length;
    t6.push({ true_pct: +(truth * 100).toFixed(0), est_mean_pct: +mean.toFixed(3), bias_pp: +(mean - truth * 100).toFixed(3), sd_pp: +sd.toFixed(3), mae_pp: +mae.toFixed(3) });
    console.log(`  ${Math.round(truth * 100)}%: 估计 ${mean.toFixed(3)}%  偏差 ${(mean - truth * 100).toFixed(3)} pp  SD ${sd.toFixed(3)} pp  MAE ${mae.toFixed(3)} pp`);
}
dump('表6_丢包率精度.csv', t6);

/* ---------- 表7 误报率（真实白噪声） ---------- */
console.log('\n=== 表7 误报率（真实白噪声，T=90 s，300 s × 200 次）===');
const t7 = [];
for (const sig of [0.5, 0.7, 1.0, 1.5, 2.0]) {
    let k = 0, total = 0; const NT = 200;
    for (let i = 0; i < NT; i++) {
        const e = new AlarmEngine(CFG); const r = rng(200000 + i * 17);
        for (let t = 0; t <= 300000; t += 1000) e.push({ t, ...BASE, temperature: 25 + gauss(r) * sig });
        const a = e.alarms.filter((x) => x.signal === 'temperature');
        if (a.length > 0) k++; total += a.length;
    }
    t7.push({ sigma_W_C: sig, trials: NT, with_false_alarm: k, pct: +(k / NT * 100).toFixed(2), total_alarms: total });
    console.log(`  σ_W=${sig} ℃: ${k}/${NT} 次试验出现告警（${(k / NT * 100).toFixed(1)}%），总告警 ${total} 条`);
}
dump('表7_误报率.csv', t7);

/* ---------- 表8 缓变发现时延 ---------- */
console.log('\n=== 表8 缓变发现时延（T=90 s，观测上限 3600 s）===');
function rampLat(cfg, rate, seed) {
    const e = new AlarmEngine(cfg); const r = rng(seed);
    for (let t = 0; t <= 3600000; t += 1000) e.push({ t, ...BASE, temperature: 25 + (rate / 60) * (t / 1000) + gauss(r) * 0.3, truthOnsetMs: 0 });
    const a = e.alarms.filter((x) => x.signal === 'temperature');
    return a.length ? a[0].t / 1000 : null;
}
const thrOnly = JSON.parse(JSON.stringify(std.ALARM_DEFAULTS));
for (const k of Object.keys(thrOnly)) delete thrOnly[k].rocPerMin;
const t8 = [];
for (const rate of [1, 2, 3, 5, 10, 20]) {
    const a = rampLat({ thresholds: thrOnly }, rate, 41000 + rate);
    const d = rampLat(CFG, rate, 43000 + rate);
    t8.push({ rate: rate, threshold_s: a, proposed_s: d, advance_s: (a !== null && d !== null) ? a - d : null });
    console.log(`  ${rate} ℃/min: 纯阈值 ${a === null ? '漏检' : a + ' s'}  本文 ${d === null ? '未检出' : d + ' s'}  提前 ${(a !== null && d !== null) ? (a - d) + ' s' : '—'}`);
}
dump('表8_缓变时延.csv', t8);

console.log('\n完成。数据已写入：表6_丢包率精度.csv / 表7_误报率.csv / 表8_缓变时延.csv');
