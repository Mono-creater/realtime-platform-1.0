// verify_maint.js —— 运维闭环复现（论文表5 状态机 / 表15 健康指数 / 式9 MTTR / 式8 RUL）
'use strict';
const { MaintenanceService, GRADE, TRANSITIONS } = require('../maintenance.js');

console.log('==== 表5 工单状态机迁移关系 ====');
for (const [act, tr] of Object.entries(TRANSITIONS)) {
    console.log(`  ${act.padEnd(9)} | 允许起始: ${tr.from.join(' / ').padEnd(28)} | 目标: ${tr.target.padEnd(12)} | 记录: ${tr.record}`);
}

console.log('\n==== 表5 合法/非法迁移验证 ====');
const ms = new MaintenanceService();
const o1 = ms.create({ deviceId: 'D1', alarmId: 1, level: 'warning', description: '测试' });
console.log('  未指派直接开工 :', ms.start(o1.id, 'w1', 1000).ok ? '[!!] 被放行' : '[OK] 被拒绝');
console.log('  指派           :', ms.assign(o1.id, 'w1', 2000).ok ? '[OK] 通过' : '[!!]');
console.log('  指派后取消     :', ms.cancel(o1.id, 'w1', 2500, '').ok ? '[!!] 空原因被放行' : '[OK] 空原因被拒绝');
console.log('  指派后取消(有因):', ms.cancel(o1.id, 'w1', 2600, '复核确认误报').ok ? '[OK] 通过（论文表5：cancel 允许自 assigned）' : '[!!] 被拒');
const o2 = ms.create({ deviceId: 'D2', alarmId: 2, level: 'major', description: '测试2' });
ms.assign(o2.id, 'w2', 3000); ms.start(o2.id, 'w2', 4000);
console.log('  处理中取消     :', ms.cancel(o2.id, 'w2', 5000, '误报').ok ? '[OK] 通过（论文表5：cancel 允许自 in_progress）' : '[!!] 被拒');
const o3 = ms.create({ deviceId: 'D3', alarmId: 3, level: 'critical', description: '测试3' });
ms.assign(o3.id, 'w3', 6000); ms.start(o3.id, 'w3', 7000); ms.complete(o3.id, 'w3', 8000, '已更换');
console.log('  完成后取消     :', ms.cancel(o3.id, 'w3', 9000, 'x').ok ? '[!!] 被放行' : '[OK] 被拒绝（completed 为受保护终态）');
console.log('  审计轨迹条数   :', ms.auditTrail(o3.id).length, '（创建+3 次流转=4）');

console.log('\n==== 表15 健康指数 H = 100 − (pF+pσ+pT+pA) ====');
console.log('  偏离/N 波动σ/N 温峰/℃ 告警 | 复算扣分             | 复算分值 分级      | 论文扣分明细        论文分值');
const rows = [
    [0, 0, 25, 0, '0 / 0 / 0 / 0', 100],
    [5, 3, 30, 1, '2.5 / 2.4 / 0 / 2.5', 93],
    [15, 8, 45, 2, '7.5 / 6.4 / 0 / 5.0', 81],
    [25, 12, 60, 4, '12.5 / 9.6 / 0 / 10.0', 68],
    [40, 20, 78, 8, '20.0 / 16.0 / 0 / 20.0', 44],
    [60, 30, 85, 12, '25.0 / 24.0 / 12.5 / 25.0', 14],
    [100, 40, 100, 20, '25.0 / 25.0 / 25.0 / 25.0', 0],
];
let allOk = true;
const norm = (s) => s.split('/').map((x) => Number(x.trim())).map((x) => x.toFixed(1)).join('/');
for (const [dev, sd, tmax, n24, expStr, expScore] of rows) {
    const h = ms.healthIndex({ forceMean: 100 + dev, forceTarget: 100, forceStd: sd, tempMax: tmax, alarmCount24h: n24 });
    const mine = `${h.penalties.force} / ${h.penalties.wave} / ${h.penalties.temp} / ${h.penalties.alarm}`;
    const ok = h.score === expScore && norm(mine) === norm(expStr);
    if (!ok) allOk = false;
    console.log(`  ${String(dev).padStart(4)}  ${String(sd).padStart(6)}  ${String(tmax).padStart(6)}  ${String(n24).padStart(4)} | ${mine.padEnd(20)}| ${String(h.score).padStart(4)} ${h.grade.padEnd(8)} | ${expStr.padEnd(20)}${String(expScore).padStart(4)}  ${ok ? '[OK]' : '[!!]'}`);
}
console.log(allOk ? '  → 7 行全部与论文表15 一致（分值＋扣分明细）[OK]' : '  → 存在偏差 [!!]');

console.log('\n==== 式(9) MTTR ====');
const ms2 = new MaintenanceService();
for (let i = 0; i < 60; i++) ms2.create({ deviceId: 'D', alarmId: i, at: i * 1000 });
for (let i = 0; i < 60; i++) {
    const id = ms2.orders[i].id;
    ms2.assign(id, 'w', i * 1000);           // new → assigned
    ms2.start(id, 'w', i * 1000);            // assigned → in_progress
    ms2.complete(id, 'w', i * 1000 + 71.5 * 60000);  // in_progress → completed
}
console.log('  60 张工单、单张 71.5 min → MTTR =', ms2.mttr(), 'min  [平台 71.5 min（论文 P143 示例口径为 84.2 min，无数据集归档，平台保留 71.5）]');

console.log('\n==== KPI 复算（论文 §4.5）====');
const std = require('../standards.js');
console.log('  可用率 720h/停机8h  =', std.availability(8 * 3600000, 720 * 3600000).toFixed(4), ' [论文 0.9889]');
console.log('  完整率 998/1000     =', std.dataCompleteness(998, 1000).toFixed(4), ' [论文 0.998]');
console.log('  丢包率 3/43200      =', std.packetLossRate(3, 43200).toExponential(2), ' [论文 6.9×10⁻⁵]');

console.log('\n==== 式(8) RUL 接入 ====');
const ms3 = new MaintenanceService({ rulWindowMin: 30, rulMinSlope: 0.001 });
for (let t = 0; t <= 600000; t += 60000) ms3.pushSample('temperature', t, 25 + 1.0 * (t / 60000));
const est = ms3.rulEstimate('temperature');
console.log('  退化 1 ℃/min，阈值 80 ℃，10 min 后:', JSON.stringify({ beta: est.beta, rul: est.rul, note: est.note }));
console.log('  理论: β=1.0，RUL=(80−35)/1=45 min');
