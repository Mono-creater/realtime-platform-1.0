/**
 * e4_verify.js —— 数据质量码状态机"2 万次随机查询一致"验证（修正版）
 *
 * 原 exp_R5_all.js 的 E4 用例漏掉了 `lm.onPacket(...)`，导致 lastPacketAt 恒为 null、
 * quality() 恒返回 BAD，与期望 3303 次不一致。本脚本补上基准帧后重测。
 */
'use strict';
const { LinkMonitor } = require('./link-monitor.js');

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }

const lm = new LinkMonitor({ staleMs: 3000, badMs: 10000 });
const r = rng(9090);
let mism = 0, N = 20000;
const cnt = { GOOD: 0, STALE: 0, BAD: 0 };
const lastAt = 100000;
lm.onPacket({ t: lastAt, seq: 1 });   // 关键修正：建立"最近一帧报文"时刻基准
for (let i = 0; i < N; i++) {
    const t = lastAt + r() * 60000;
    const age = t - lastAt;
    const want = age > lm.cfg.badMs ? 'BAD' : (age > lm.cfg.staleMs ? 'STALE' : 'GOOD');
    const got = lm.quality(t);
    cnt[got]++;
    if (got !== want) mism++;
}
console.log(`数据质量码 ${N} 次随机查询：不一致 ${mism} 次`);
console.log(`分布：GOOD ${cnt.GOOD} / STALE ${cnt.STALE} / BAD ${cnt.BAD}`);
console.log(`结论：${mism === 0 ? '与式(3)完全一致' : '存在不一致'}`);
