// verify_seq.js —— 序号连续性判据复现（论文表8 序号边界用例）
// 对照"修正前"（直接以 65 536 为模、序号 0 计入）与"修正后"（1.0 平台实现）
'use strict';
const { LinkMonitor } = require('../link-monitor.js');

/** 修正前：直接以 65 536 为模，序号 0 亦计入连续性统计 */
function legacyRun(seqs) {
    let last = null, gaps = 0, exp = 0;
    for (const s of seqs) {
        if (last === null) { exp += 1; last = s; continue; }
        const d = (s - last + 65536) % 65536;
        if (d === 0) { /* dup */ }
        else if (d > 1) { gaps += d - 1; exp += d; }
        else { exp += 1; }
        last = s;
    }
    return { gaps, exp };
}

/** 修正后：1.0 平台实现 */
function fixedRun(seqs) {
    const lm = new LinkMonitor();
    let t = 0;
    for (const s of seqs) lm.onPacket({ t: (t += 1000), seq: s });
    return { gaps: lm.gaps, exp: lm.expected, legacy: lm.legacyFrames, wraps: lm.wraps };
}

const SEQ_MAX = 65535;

// 用例 1：完整回绕周期 65 535 帧、零丢包（含 65535→1 回绕点）
const c1 = Array.from({ length: SEQ_MAX }, (_, i) => i + 1).concat([1]);   // 1..65535, 再回绕到 1
// 用例 2：跨越回绕边界、零丢包（9 帧，修正前 d(65535→1)=2 → 1 缺口 → 丢包率 1/9=11.11%）
const c2 = [65531, 65532, 65533, 65534, 65535, 1, 2, 3, 4];
// 用例 3：回绕边界处丢 1 帧（丢失序号 1）
const c3 = [65533, 65534, 65535, 2, 3, 4];
// 用例 4：中途丢 3 帧
const c4 = [100, 101, 102, 106, 107];
// 用例 5：流中插入序号 0（旧固件）——0 帧被排除，基准保持为 5，故 5→6 连续
const c5 = [1, 2, 3, 4, 5, 0, 6, 7, 8];
// 用例 6：额外——回绕点特判是否生效
const c6 = [65535, 1];
// 用例 7：额外——重复帧不计缺口
const c7 = [10, 10, 11];

const cases = [
    ['完整回绕周期 65 535 帧、零丢包', c1, 1, 0],
    ['跨越回绕边界、零丢包',          c2, 1, 0],
    ['回绕边界处丢 1 帧',             c3, null, 2],
    ['中途丢 3 帧',                   c4, null, 3],
    ['流中插入序号 0（旧固件）',      c5, null, 0],
    ['回绕点 65535→1（特判）',        c6, 1, 0],
    ['重复帧不计缺口',                c7, null, 0],
];

console.log('用例                                | 修正前 | 修正后(1.0) | 论文"修正后"');
console.log('------------------------------------|--------|-------------|-------------');
for (const [name, seqs, legacyExp, fixedExp] of cases) {
    const l = legacyRun(seqs), f = fixedRun(seqs);
    const okMark = f.gaps === fixedExp ? ' [OK]' : ' [!!]';
    console.log(`${name.padEnd(35)}| ${String(l.gaps).padStart(6)} | ${String(f.gaps).padStart(11)} | ${String(fixedExp).padStart(11)}${okMark}`);
}

console.log('\n=== Wilson 区间（论文 §4.3：零缺口 0/100 上界 3.7%）===');
const lm = new LinkMonitor();
for (let i = 1; i <= 100; i++) lm.onPacket({ t: i * 1000, seq: i });
const st = lm.stats(100000);
console.log('  100 帧零缺口: gaps=%d expected=%d lossRate=%s', st.gaps, st.expected, st.lossRate);
console.log('  Wilson 95%CI = [%s%%, %s%%]  (论文 0/100 上界 3.7%%)',
    (st.lossCI.lo * 100).toFixed(2), (st.lossCI.hi * 100).toFixed(2));

console.log('\n=== 质量码与退避（论文 §2.2/§4.3）===');
const lm2 = new LinkMonitor();
lm2.onPacket({ t: 0, seq: 1 });
console.log('  t=0.1s:', lm2.quality(100), '| t=3.1s:', lm2.quality(3100), '| t=10.1s:', lm2.quality(10100), '（论文：GOOD / STALE / BAD）');
lm2.onPacket({ t: 11000, seq: 2 });
console.log('  恢复一帧后:', lm2.quality(11001), '（论文：立即回到 GOOD）');
const lm3 = new LinkMonitor();
const backoff = [];
for (let i = 0; i < 6; i++) { lm3.onError(); backoff.push(lm3.nextRetryDelay()); }
console.log('  退避序列（6 次）:', backoff.map((x) => (x / 1000).toFixed(2) + 's').join(', '));
console.log('  名义间隔应为 0.5/1/2/4/8/8 s，抖动 ±10%% 且不超过 8 s');
