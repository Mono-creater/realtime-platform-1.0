/** 导出图 5 用的阶跃响应曲线（3 策略对比，标称接触力通道） */
'use strict';
const fs = require('fs');
const v2 = require('D:/realtime-platform/realtime-platform-main/control-engine-v2');
const OUT = 'D:/workspace/deepseek/recon/exp';

const K = 1.0, tau = 2.0, L = 0.6, dt = 0.5, target = 100, y0 = 70, u0 = 70;
const te = -dt / Math.log(1 - dt / tau), le = Math.ceil(L / dt) * dt - dt;
const common = { K, gain: K, tau, L, dt, target, y0, u0, uMin: 50, uMax: 1000, ticks: 600 };

const cases = [
  ['ZN直接', v2.znGains(K, te, le)],
  ['安全折减ZN', v2.tuneSafe(K, te, le)],
  ['IMC-PI', v2.imcGains(K, te, le)],
  ['出厂保守', { kp: 1.5, ki: 0.5, kd: 0.5 }],
];

const lines = ['strategy,t,y,u'];
const metricsRows = ['strategy,kp,ki,kd,overshootPct,settleS,sse,riseS'];
for (const [name, g] of cases) {
  const gm = { kp: g.kp, ki: g.ki, kd: g.kd || 0 };
  const r = v2.simulateClosedLoop(Object.assign({}, common, { gains: gm, derivFilterN: 8, integralSeparation: 0.35 }));
  r.curve.forEach((p) => lines.push([name, p.t, p.y.toFixed(4), p.u.toFixed(3)].join(',')));
  const m = r.metrics;
  metricsRows.push([name, gm.kp.toFixed(4), gm.ki.toFixed(4), gm.kd.toFixed(4), m.overshootPct, m.settleS, m.sse, m.riseS].join(','));
}
fs.writeFileSync(OUT + '/fig5_step_curves.csv', lines.join('\n'), 'utf8');
fs.writeFileSync(OUT + '/fig5_step_metrics.csv', metricsRows.join('\n'), 'utf8');
console.log('curves rows=' + (lines.length - 1));
console.log(metricsRows.join('\n'));
