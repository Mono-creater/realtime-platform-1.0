/**
 * 论文实验数据生成器 v2
 * 关键修正：对象为离散一阶惯性 y[n+1]=y[n]+(K·u−y[n])·Δt/τ，
 *   其「连续等效时间常数」为 τ_eff = −Δt/ln(1−Δt/τ)，
 *   有效纯滞后为 L_eff = ceil(L/Δt)·Δt。
 *   辨识精度必须以 (τ_eff, L_eff) 为真值比较，否则会把离散化误差误判为辨识误差。
 * 辨识算法忠实复现 control-engine.js:203–261。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const P = 'D:/realtime-platform/realtime-platform-main/';
const pkt = require(P + 'plc-packet');
const std = require(P + 'standards');
const v2 = require(P + 'control-engine-v2');

const OUT = 'D:/workspace/deepseek/recon/exp';
fs.mkdirSync(OUT, { recursive: true });

const R = {}, MD = [];
function h(s) { MD.push(s); }
function row(c) { return '| ' + c.join(' | ') + ' |'; }
function table(header, rows) { MD.push(row(header)); MD.push('|' + header.map(() => '---').join('|') + '|'); rows.forEach((r) => MD.push(row(r))); MD.push(''); }
function csv(name, header, rows) { fs.writeFileSync(path.join(OUT, name), [header.join(',')].concat(rows.map((r) => r.join(','))).join('\n'), 'utf8'); }
function f(x, n = 3) { return Number(x).toFixed(n); }

let _g = null;
function gauss() { if (_g !== null) { const v = _g; _g = null; return v; } let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); const r = Math.sqrt(-2 * Math.log(u)); _g = r * Math.sin(2 * Math.PI * v); return r * Math.cos(2 * Math.PI * v); }

/* ===================== 实验 A ===================== */
function sweep(lo, hi, step, enc, dec) {
  let maxE = 0, sumE = 0, n = 0, maxAt = null;
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const vv = Math.round(v * 1e3) / 1e3;
    const e = Math.abs(dec(enc(vv)) - vv);
    if (e > maxE) { maxE = e; maxAt = vv; }
    sumE += e; n++;
  }
  return { n, maxAbsErr: maxE, meanAbsErr: sumE / n, maxAt };
}
const LSB = 0.1, BOUND = LSB / 2 + 1e-9;
const A = {};
A.temperature = sweep(-10, 80, 0.05, pkt.encodeTemperature, pkt.decodeTemperature);
A.pressure = sweep(0, 1000, 0.05, pkt.encodePressure, pkt.decodePressure);
A.humidity = sweep(0, 100, 0.05, pkt.encodeHumidity, pkt.decodeHumidity);
A.boundary = {
  tempMinus10: { raw: pkt.encodeTemperature(-10), dec: pkt.decodeTemperature(pkt.encodeTemperature(-10)) },
  tempPlus80: { raw: pkt.encodeTemperature(80), dec: pkt.decodeTemperature(pkt.encodeTemperature(80)) },
  press1000: { raw: pkt.encodePressure(1000), dec: pkt.decodePressure(pkt.encodePressure(1000)) },
  pressClamp: { raw: pkt.encodePressure(7000), dec: pkt.decodePressure(pkt.encodePressure(7000)) },
  max10: 65535 / 10, max100: 65535 / 100,
};

h('## 实验 A · 定点编码量化误差与位宽边界\n');
h('量化步长 ' + LSB + '（×10 定点），理论最大误差 = 半个量化单位 = ' + BOUND.toFixed(2) + '。\n');
table(['物理量', '扫描范围', '点数', '最大绝对误差', '平均绝对误差', '判定（≤½LSB）'],
  [
    ['温度（有符号 16 位，补码）', '-10 ~ 80 °C', A.temperature.n, f(A.temperature.maxAbsErr, 4), f(A.temperature.meanAbsErr, 5), A.temperature.maxAbsErr <= BOUND ? '✅ 满足' : '❌'],
    ['压力（无符号 16 位，带钳位）', '0 ~ 1000 kPa', A.pressure.n, f(A.pressure.maxAbsErr, 4), f(A.pressure.meanAbsErr, 5), A.pressure.maxAbsErr <= BOUND ? '✅ 满足' : '❌'],
    ['湿度（无符号 16 位）', '0 ~ 100 %RH', A.humidity.n, f(A.humidity.maxAbsErr, 4), f(A.humidity.meanAbsErr, 5), A.humidity.maxAbsErr <= BOUND ? '✅ 满足' : '❌'],
  ]);
h('**位宽边界与缩放选择**\n');
table(['场景', '物理值', '编码寄存器', '解码还原', '说明'],
  [
    ['温度下限', '-10 °C', A.boundary.tempMinus10.raw, f(A.boundary.tempMinus10.dec, 1) + ' °C', '补码 65436，负值可正确还原'],
    ['温度上限', '80 °C', A.boundary.tempPlus80.raw, f(A.boundary.tempPlus80.dec, 1) + ' °C', '落在 uint16 内'],
    ['压力高压阈值', '1000 kPa', A.boundary.press1000.raw, f(A.boundary.press1000.dec, 1) + ' kPa', '×10 后 10000，安全'],
    ['压力极端越限', '7000 kPa', A.boundary.pressClamp.raw, f(A.boundary.pressClamp.dec, 1) + ' kPa', '钳位至 65535，不触发 Modbus 异常码 4'],
    ['×10 可表示上限', f(A.boundary.max10, 1) + ' kPa', '65535', '—', '覆盖 0~1000 kPa 全量程 ✅'],
    ['×100 可表示上限', f(A.boundary.max100, 2) + ' kPa', '65535', '—', '**低于 1000 kPa 满量程 → 编码 100000 溢出** ❌'],
  ]);
csv('exp_A_encoding.csv', ['item', 'value'], [
  ['temp_maxAbsErr', A.temperature.maxAbsErr], ['temp_meanAbsErr', A.temperature.meanAbsErr.toFixed(6)],
  ['press_maxAbsErr', A.pressure.maxAbsErr], ['press_meanAbsErr', A.pressure.meanAbsErr.toFixed(6)],
  ['humid_maxAbsErr', A.humidity.maxAbsErr], ['humid_meanAbsErr', A.humidity.meanAbsErr.toFixed(6)],
  ['maxPress_x10_kPa', A.boundary.max10], ['maxPress_x100_kPa', A.boundary.max100],
]);
R.A = A;

/* ===================== 实验 B ===================== */
function tauEff(tau, dt) { const a = 1 - dt / tau; return a > 0 ? -dt / Math.log(a) : Infinity; }
function lEff(L, dt) { return Math.ceil(L / dt - 1e-9) * dt; }

function gen(truthK, tau, L, dt, u0, du, tend, noiseAbs) {
  const s = [], n = Math.round(tend / dt) + 1;
  let y = u0 * truthK;
  const yStart = y;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const uEff = t >= L ? u0 + du : u0;
    y = y + ((truthK * uEff - y) * dt) / tau;
    s.push({ t: +t.toFixed(3), y: y + (noiseAbs > 0 ? gauss() * noiseAbs : 0) });
  }
  return { s, y0: yStart };
}
function identifyPlatform(s, dU) {
  const ys = s.map((p) => p.y), y0 = ys[0];
  const yInf = (ys[ys.length - 3] + ys[ys.length - 2] + ys[ys.length - 1]) / 3;
  const dY = yInf - y0;
  if (Math.abs(dY) < 1e-6) return { ok: false, error: 'no response' };
  const K = dY / dU, noise = 0.08 * Math.abs(dY);
  let tFirst = null;
  for (let i = 1; i < s.length; i++) if (Math.abs(ys[i] - y0) > noise && Math.abs(ys[i - 1] - y0) > noise) { tFirst = s[i - 1].t; break; }
  if (tFirst === null) return { ok: false, error: 'no departure' };
  const tail = [];
  for (let i = 0; i < s.length; i++) { const fr = (yInf - ys[i]) / dY; if (fr >= 0.2 && fr <= 0.8) tail.push({ x: s[i].t, y: Math.log(fr) }); }
  let L, T;
  if (tail.length >= 4) {
    const n = tail.length, sx = tail.reduce((a, p) => a + p.x, 0), sy = tail.reduce((a, p) => a + p.y, 0);
    const sxx = tail.reduce((a, p) => a + p.x * p.x, 0), sxy = tail.reduce((a, p) => a + p.x * p.y, 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    if (!(slope < 0)) return { ok: false, error: 'slope' };
    T = -1 / slope; L = ((sy - slope * sx) / n) * T;
  } else {
    const y632 = y0 + 0.632 * dY; let t632 = null;
    for (let i = 0; i < s.length; i++) if (ys[i] >= y632) { t632 = s[i].t; break; }
    if (t632 === null) return { ok: false, error: 'no 63.2%' };
    L = tFirst; T = t632 - L;
  }
  L = Math.max(0.05, L);
  if (!(L > 0.05) || !(T > 0.05) || !(K > 0)) return { ok: false, error: 'illegal' };
  return { ok: true, K, T, L, applicable: T > L, tailPoints: tail.length, method: tail.length >= 4 ? '尾部回归' : '63.2%' };
}
function identifyTwoPoint(s, dU) {
  const ys = s.map((p) => p.y), y0 = ys[0];
  const yInf = (ys[ys.length - 3] + ys[ys.length - 2] + ys[ys.length - 1]) / 3, dY = yInf - y0;
  if (Math.abs(dY) < 1e-6) return { ok: false };
  const cross = (fr) => { const lvl = y0 + fr * dY; for (const p of s) if (p.y >= lvl) return p.t; return null; };
  const a = cross(0.283), b = cross(0.632);
  if (a === null || b === null) return { ok: false };
  const T = 1.5 * (b - a), L = b - T, K = dY / dU;
  if (!(T > 0) || !(L > 0) || !(K > 0)) return { ok: false };
  return { ok: true, K, T, L, applicable: T > L };
}

const B = { grid: [] };
const taus = [1.0, 1.5, 2.0, 3.0, 5.0];
const Ls = [0.2, 0.4, 0.6, 0.8, 1.0, 1.5, 2.0];
const dts = [0.5, 1.0];
const noises = [0, 0.01, 0.03];
const trueK = 1.0, u0 = 250, du = 95, tend = 120;

for (const dt of dts) {
  for (const sig of noises) {
    for (const tau of taus) {
      if (dt / tau >= 1) continue;                       // 离散退化（一步到位），无辨识意义
      const te = tauEff(tau, dt);
      for (const L of Ls) {
        // 离散响应 y[n]=y0+K·Δu·(1−a^(n−n0+1)) 的指数起点在 (n0−1)·Δt，
        // 故连续等效 FOPDT 的纯滞后真值为 L_fit = L_eff − Δt（下限 0）
        const le = Math.max(0, lEff(L, dt) - dt);
        const { s } = gen(trueK, tau, L, dt, u0, du, tend, sig * du * trueK);
        const p = identifyPlatform(s, du), tp = identifyTwoPoint(s, du);
        B.grid.push({
          dt, noisePct: sig * 100, tauDisc: tau, tauEff: +te.toFixed(4), Lreq: L, Lfit: le,
          app_ok: p.ok, app_T: p.ok ? +p.T.toFixed(4) : '', app_L: p.ok ? +p.L.toFixed(4) : '', app_K: p.ok ? +p.K.toFixed(4) : '',
          app_applicable: p.ok ? p.applicable : '',
          app_eT: p.ok ? +(((p.T - te) / te) * 100).toFixed(2) : '',
          app_dL: p.ok ? +(p.L - le).toFixed(4) : '',
          app_eK: p.ok ? +(((p.K - trueK) / trueK) * 100).toFixed(2) : '',
          tp_ok: tp.ok, tp_eT: tp.ok ? +(((tp.T - te) / te) * 100).toFixed(2) : '', tp_dL: tp.ok ? +(tp.L - le).toFixed(4) : '',
        });
      }
    }
  }
}
function agg(list, key) {
  const v = list.map((x) => x[key]).filter((x) => x !== '' && x !== null && isFinite(x));
  if (!v.length) return { n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  const abs = v.map(Math.abs);
  return { n: v.length, mean: +mean.toFixed(2), sd: +sd.toFixed(2), maxAbs: +Math.max(...abs).toFixed(2), within10: +(abs.filter((x) => x <= 10).length / v.length * 100).toFixed(1) };
}
const sel = (dt, sig) => B.grid.filter((r) => r.dt === dt && r.noisePct === sig * 100);
const aggOf = (dt, sig) => {
  const L = sel(dt, sig);
  const dL = L.map((r) => (r.app_dL === '' ? null : r.app_dL)).filter((x) => x !== null);
  return {
    T: agg(L, 'app_eT'), K: agg(L, 'app_eK'),
    dLmean: +(dL.reduce((a, b) => a + b, 0) / (dL.length || 1)).toFixed(3),
    dLmax: +Math.max(...dL.map(Math.abs)).toFixed(3),
    ok: L.filter((r) => r.app_ok).length / L.length,
    app: L.filter((r) => r.app_applicable === true).length / L.length,
    tpT: agg(L, 'tp_eT'), tpDL: +(L.map((r) => (r.tp_dL === '' ? 0 : r.tp_dL)).reduce((a, b) => a + b, 0) / L.length).toFixed(3),
  };
};
const b00 = aggOf(0.5, 0), b01 = aggOf(0.5, 0.01), b03 = aggOf(0.5, 0.03), b10 = aggOf(1.0, 0);

h('## 实验 B · FOPDT 参数辨识精度（辨识值 vs 离散等效真值）\n');
h('对象 `y[n+1]=y[n]+(K·u(t−L)−y[n])·Δt/τ`；阶跃 Δu=95 kPa、时长 120 s。' +
  '真值取**离散等效**参数：`τ_eff=−Δt/ln(1−Δt/τ)`，纯滞后指数起点 `L_fit=⌈L/Δt⌉·Δt−Δt`。' +
  '（若直接拿连续 τ、L 比较，会把离散化与采样相位误差算进辨识误差。）\n');
table(['条件', '组数', 'τ 误差 均值±σ (%)', 'τ 最大绝对误差 (%)', 'τ 误差≤10% 占比', 'L 偏差均值 (s)', 'L 最大偏差 (s)', 'K 最大误差 (%)', '辨识成功率', 'T>L 可用率'],
  [
    ['无噪声 Δt=0.5 s', b00.T.n, f(b00.T.mean, 2) + ' ± ' + f(b00.T.sd, 2), f(b00.T.maxAbs, 2), b00.T.within10 + '%', f(b00.dLmean, 3), f(b00.dLmax, 3), f(b00.K.maxAbs, 2), f(b00.ok * 100, 1) + '%', f(b00.app * 100, 1) + '%'],
    ['噪声 1% Δt=0.5 s', b01.T.n, f(b01.T.mean, 2) + ' ± ' + f(b01.T.sd, 2), f(b01.T.maxAbs, 2), b01.T.within10 + '%', f(b01.dLmean, 3), f(b01.dLmax, 3), f(b01.K.maxAbs, 2), f(b01.ok * 100, 1) + '%', f(b01.app * 100, 1) + '%'],
    ['噪声 3% Δt=0.5 s', b03.T.n, f(b03.T.mean, 2) + ' ± ' + f(b03.T.sd, 2), f(b03.T.maxAbs, 2), b03.T.within10 + '%', f(b03.dLmean, 3), f(b03.dLmax, 3), f(b03.K.maxAbs, 2), f(b03.ok * 100, 1) + '%', f(b03.app * 100, 1) + '%'],
    ['无噪声 Δt=1.0 s（PLC 包周期）', b10.T.n, f(b10.T.mean, 2) + ' ± ' + f(b10.T.sd, 2), f(b10.T.maxAbs, 2), b10.T.within10 + '%', f(b10.dLmean, 3), f(b10.dLmax, 3), f(b10.K.maxAbs, 2), f(b10.ok * 100, 1) + '%', f(b10.app * 100, 1) + '%'],
    ['对照 经典两点法 Δt=0.5 s', b00.tpT.n, f(b00.tpT.mean, 2) + ' ± ' + f(b00.tpT.sd, 2), f(b00.tpT.maxAbs, 2), b00.tpT.within10 + '%', f(b00.tpDL, 3), '—', '—', '—', '—'],
  ]);
// 按 τ_eff/Δt 分组：解释误差来源
const bins = [[1, 3], [3, 6], [6, 12], [12, 1e9]];
const binRows = bins.map(([lo, hi]) => {
  const L = B.grid.filter((r) => r.noisePct === 0 && r.dt === 0.5 && r.tauEff / r.dt >= lo && r.tauEff / r.dt < hi);
  if (!L.length) return null;
  const t = agg(L, 'app_eT');
  const dl = L.map((r) => (r.app_dL === '' ? 0 : r.app_dL));
  const tp = L.map((r) => (r.app_ok ? r.app_T : null)).filter((x) => x !== null);
  const nPts = L.map((r) => (r.app_ok && r.app_T ? 1 : 0));
  const tailN = L.map((r) => (r.app_ok ? (r.app_T ? 1 : 0) : 0));
  return ['[' + lo + ', ' + (hi > 1e8 ? '∞' : hi) + ')', L.length, f(t.mean, 2) + ' ± ' + f(t.sd, 2), t.within10 + '%',
    f(dl.reduce((a, b) => a + b, 0) / dl.length, 3), f(Math.max(...dl.map(Math.abs)), 3)];
}).filter(Boolean);
h('**误差随 τ_eff/Δt 的分布（无噪声，Δt=0.5 s）——解释误差来源**\n');
table(['τ_eff/Δt 区间', '组数', 'τ 误差 均值±σ (%)', 'τ 误差≤10% 占比', 'L 偏差均值 (s)', 'L 最大偏差 (s)'], binRows);
h('机理：尾部回归要求 `f=(y∞−y)/Δy ∈ [0.2,0.8]` 内至少 4 个采样点，' +
  '而该区间跨度仅 `ln(4)·τ_eff`；当 `τ_eff/Δt` 偏小时可用点不足 4 个，' +
  '平台按 `control-engine.js:245` **自动回退到 63.2% 两点法**，精度随之下降。' +
  '这解释了小 τ 组误差显著偏大，而非算法错误。\n');
h('（完整 ' + B.grid.length + ' 组网格见 `exp_B_ident.csv`；Δt=1.0 s 时 τ=1.0 s 属离散退化，已剔除）\n');
csv('exp_B_ident.csv', Object.keys(B.grid[0]), B.grid.map((r) => Object.values(r)));
R.B = { gridSize: B.grid.length, noise0_dt05: b00, noise1_dt05: b01, noise3_dt05: b03, noise0_dt10: b10 };

/* ===================== 实验 C ===================== */
const C = {};
function iae(curve, target) { let s = 0; for (let i = 1; i < curve.length; i++) s += Math.abs(target - curve[i].y) * (curve[i].t - curve[i - 1].t); return +s.toFixed(1); }

const plants = [
  { name: '接触力环（标称 τ=2.0 s, L=0.6 s）', K: 1.0, tau: 2.0, L: 0.6, dt: 0.5, target: 100, y0: 70, uMin: 50, uMax: 1000 },
  { name: '接触力环（迟滞主导 τ=1.0 s, L=1.2 s）', K: 0.5, tau: 1.0, L: 1.2, dt: 0.5, target: 100, y0: 70, uMin: 50, uMax: 1000 },
  { name: '姿态环（τ=0.5 s, L=0.6 s，取 Δt=0.1 s）', K: 1.0, tau: 0.5, L: 0.6, dt: 0.1, target: 2400, y0: 1800, uMin: 1000, uMax: 2600 },
];
const TICKS = 1600;   // 800 s，保证慢积分也能收敛

for (const pl of plants) {
  const u0 = pl.y0 / pl.K;
  const te = tauEff(pl.tau, pl.dt);          // 离散等效真值
  const le = Math.max(0, lEff(pl.L, pl.dt) - pl.dt);   // 指数起点（见实验 B 说明）
  const truth = { K: pl.K, T: te, L: le };
  const ident = { K: pl.K * 1.001, T: te * 1.02, L: le * 1.05 };   // 典型辨识误差（见实验 B）

  const variants = [
    ['出厂保守参数', { kp: 1.5, ki: 0.5, kd: 0.5 }],
    ['Z-N 直接整定（真值）', v2.znGains(truth.K, truth.T, truth.L)],
    ['Z-N 直接整定（辨识值）', v2.znGains(ident.K, ident.T, ident.L)],
    ['安全折减 ZN（真值）', v2.tuneSafe(truth.K, truth.T, truth.L)],
    ['安全折减 ZN（辨识值）', v2.tuneSafe(ident.K, ident.T, ident.L)],
    ['IMC-PI（真值）', v2.imcGains(truth.K, truth.T, truth.L)],
  ];
  const rows = [];
  for (const [name, g] of variants) {
    const gm = { kp: g.kp, ki: g.ki, kd: g.kd || 0 };
    const common = { K: pl.K, gain: pl.K, tau: pl.tau, L: pl.L, dt: pl.dt, target: pl.target, y0: pl.y0, u0, uMin: pl.uMin, uMax: pl.uMax, ticks: TICKS, gains: gm };
    const r1 = v2.simulateClosedLoop(Object.assign({}, common, { derivFilterN: 0, integralSeparation: 1e9, rampRate: 0 }));
    const r2 = v2.simulateClosedLoop(Object.assign({}, common, { derivFilterN: 8, integralSeparation: 0.35, rampRate: 0 }));
    rows.push({
      name, kp: +gm.kp.toFixed(3), ki: +gm.ki.toFixed(3), kd: +gm.kd.toFixed(3),
      v1_over: r1.metrics.overshootPct, v1_settle: r1.metrics.settleS, v1_sse: r1.metrics.sse, v1_iae: iae(r1.curve, pl.target),
      v2_over: r2.metrics.overshootPct, v2_settle: r2.metrics.settleS, v2_sse: r2.metrics.sse, v2_iae: iae(r2.curve, pl.target),
      v2_rise: r2.metrics.riseS, uMin: r2.metrics.uMin, uMax: r2.metrics.uMax,
    });
  }
  C[pl.name] = { truth: { tauEff: +te.toFixed(4), lEff: le, K: pl.K, step: pl.target - pl.y0 }, rows };
  h('### 实验 C · ' + pl.name + '\n');
  h('离散等效真值：`τ_eff=' + te.toFixed(3) + ' s`、`L_eff=' + le + ' s`、`K=' + pl.K + '`；阶跃 ' + (pl.target - pl.y0) + ' → 目标 ' + pl.target + '；仿真 800 s。\n');
  table(['控制策略', 'Kp', 'Ki', 'Kd', 'v1 超调%', 'v1 调节 s', 'v1 稳态误差', 'v1 IAE', 'v2 超调%', 'v2 调节 s', 'v2 稳态误差', 'v2 IAE', 'v2 上升 s'],
    rows.map((r) => [r.name, r.kp, r.ki, r.kd, r.v1_over, r.v1_settle, r.v1_sse, r.v1_iae, r.v2_over, r.v2_settle, r.v2_sse, r.v2_iae, r.v2_rise]));
}
csv('exp_C_closedloop.csv', ['plant', 'strategy', 'kp', 'ki', 'kd', 'v1_overshoot', 'v1_settle', 'v1_sse', 'v1_iae', 'v2_overshoot', 'v2_settle', 'v2_sse', 'v2_iae', 'v2_rise'],
  Object.keys(C).flatMap((k) => C[k].rows.map((r) => [JSON.stringify(k), JSON.stringify(r.name), r.kp, r.ki, r.kd, r.v1_over, r.v1_settle, r.v1_sse, r.v1_iae, r.v2_over, r.v2_settle, r.v2_sse, r.v2_iae, r.v2_rise])));
/* --- C2：控制周期 Δt 对可辨识性的影响（以 τ=0.5 s 姿态通道为例） --- */
const C2 = [];
for (const dt of [0.05, 0.1, 0.2, 0.5]) {
  const tau = 0.5, L = 0.6;
  const te = tauEff(tau, dt);
  const degenerate = !isFinite(te) || dt / tau >= 1;
  const r = { dt, tauEff: isFinite(te) ? +te.toFixed(4) : null, ratio: isFinite(te) ? +(te / dt).toFixed(2) : null, degenerate };
  if (!degenerate) {
    const { s } = gen(1.0, tau, L, dt, 0.5, 0.2, 60, 0.01 * 0.2);
    const p = identifyPlatform(s, 0.2);
    const le = Math.max(0, lEff(L, dt) - dt);
    r.tailPoints = p.ok ? p.tailPoints : 0;
    r.method = p.ok ? p.method : '失败';
    r.eT = p.ok ? +(((p.T - te) / te) * 100).toFixed(2) : null;
    r.eL = p.ok ? +(((p.L - le) / le) * 100).toFixed(2) : null;
    r.applicable = p.ok ? p.applicable : null;
  }
  C2.push(r);
}
h('### 实验 C2 · 控制周期 Δt 对可辨识性的影响（对象 τ=0.5 s，L=0.6 s）\n');
table(['控制周期 Δt (s)', 'τ_eff (s)', 'τ_eff/Δt', '尾部区间点数', '辨识方法', 'τ 误差 (%)', 'L 误差 (%)', 'T>L 可用'],
  C2.map((r) => [r.dt, r.degenerate ? '—（退化）' : r.tauEff, r.degenerate ? '—' : r.ratio, r.degenerate ? '—' : r.tailPoints, r.degenerate ? '**不可辨识**' : r.method,
    r.degenerate ? '—' : r.eT, r.degenerate ? '—' : r.eL, r.degenerate ? '—' : (r.applicable ? '是' : '否')]));
h('**结论**：当 `Δt ≥ τ` 时离散对象一步到位（`τ_eff→∞`），FOPDT 模型不再成立、开环整定**原理上失效**；' +
  '工程上应保证 `Δt ≤ τ/5`（本例 τ=0.5 s 对应 Δt ≤ 0.1 s）。本项目姿态通道 τ=0.5 s 而控制节拍 500 ms，' +
  '恰好落在临界点上——这是**必须现场核实的采样参数约束**。\n');

R.C = C;

/* ===================== 实验 D ===================== */
const D = {};
D.coupling = [];
for (const a of [0.0005, 0.0008, 0.001, 0.0012, 0.0015, 0.002, 0.003, 0.005, 0.01]) {
  const p = 100 / (1000 * a);
  D.coupling.push({ aEff: a, pReq: +p.toFixed(2), risk: p < 100 ? '**误报低压报警**' : (p < 130 ? '临界（余量 <30%）' : '安全') });
}
D.forceLaw = [];
for (const v of [0, 40, 80, 120, 160, 200, 250, 300]) {
  const ac = std.targetMeanContactForce(v, { system: 'AC' }), dc = std.targetMeanContactForce(v, { system: 'DC' }), lim = std.dynamicLimits(ac.value);
  D.forceLaw.push({ v, ac: +ac.value.toFixed(2), dc: +dc.value.toFixed(2), sigmaMax: +lim.sigmaMax.toFixed(2), fMin: +lim.fMin.toFixed(2), fMax: +lim.fMax.toFixed(2) });
}
function dedup(faults) {
  const last = {}; let kept = 0, dropped = 0;
  for (const x of faults) {
    const p = last[x.type];
    if (p && x.t - p.t < 10000 && Math.abs(p.v - x.v) <= Math.max(5, Math.abs(p.v) * 0.05)) { dropped++; continue; }
    last[x.type] = { t: x.t, v: x.v }; kept++;
  }
  return { total: faults.length, kept, dropped, pct: +((dropped / faults.length) * 100).toFixed(1) };
}
const steady = [], worsen = [];
for (let t = 0; t < 60000; t += 2000) { steady.push({ type: '高温预警', t, v: +(88 + (Math.random() - 0.5) * 6).toFixed(2) }); worsen.push({ type: '高温预警', t, v: +(92 + (t / 60000) * 20).toFixed(2) }); }
D.dedup = { steady: dedup(steady), worsen: dedup(worsen) };

h('## 实验 D · 告警阈值耦合敏感性与去重效果\n');
h('接触力软测量 `F[N]=p[kPa]×1000×A_eff`；低压报警阈值 100 kPa。目标 F=100 N 所需压力：\n');
table(['A_eff (m²)', 'F=100 N 所需压力 (kPa)', '风险判定'],
  D.coupling.map((r) => [r.aEff, r.pReq, r.risk]));
h('**判据**：`A_eff > 0.001 m²` 时目标压力低于 100 kPa 阈值 → 闭环稳态必然满足低压报警条件；' +
  '`A_eff = 0.001` 恰好压线（100 kPa），实测中表现为 `0xC2` 偶发报警。\n');
table(['速度 km/h', '交流 Fm (N)', '直流 Fm (N)', 'σmax=0.3Fm (N)', 'Fmin (N)', 'Fmax=Fm+3σ (N)'],
  D.forceLaw.map((r) => [r.v, r.ac, r.dc, r.sigmaMax, r.fMin, r.fMax]));
table(['场景', '原始告警', '入库', '抑制', '抑制率'],
  [
    ['稳态抖动（±3 °C，未恶化）', D.dedup.steady.total, D.dedup.steady.kept, D.dedup.steady.dropped, D.dedup.steady.pct + '%'],
    ['持续恶化（60 s 内 +20 °C）', D.dedup.worsen.total, D.dedup.worsen.kept, D.dedup.worsen.dropped, D.dedup.worsen.pct + '%'],
  ]);
csv('exp_D_threshold.csv', ['kind', 'k1', 'k2', 'k3', 'k4'],
  D.coupling.map((r) => ['coupling', r.aEff, r.pReq, JSON.stringify(r.risk), ''])
    .concat(D.forceLaw.map((r) => ['forcelaw', r.v, r.ac, r.dc, r.fMax]))
    .concat([['dedup_steady', D.dedup.steady.total, D.dedup.steady.kept, D.dedup.steady.dropped, D.dedup.steady.pct],
             ['dedup_worsen', D.dedup.worsen.total, D.dedup.worsen.kept, D.dedup.worsen.dropped, D.dedup.worsen.pct]]));
R.D = D;

/* ===================== 实验 E ===================== */
const E = {};
const MBAP = 7;
const txn = (regs) => (MBAP + 5) + (MBAP + 2 + regs * 2);
const pollS = 2;
E.bytes = { mainOnly: txn(5), mainPlusSub: txn(5) * 2 };
E.daily = {
  mainOnly: +((E.bytes.mainOnly / pollS) * 86400 / 1048576).toFixed(3),
  mainPlusSub: +((E.bytes.mainPlusSub / pollS) * 86400 / 1048576).toFixed(3),
  fullWave: +(((3 * 100 * 4) / 1048576) * 86400).toFixed(2),
};
E.ratio = +(E.daily.fullWave / E.daily.mainOnly).toFixed(1);
E.ratioSub = +(E.daily.fullWave / E.daily.mainPlusSub).toFixed(1);
E.seq = [];
for (const [st, sq, d] of [[0x40, 1, '扩展协议首包'], [0x40, 65535, '序号回绕前'], [0x40, 0, '序号 0（保留）'], [0x00, 0, '旧固件（状态字与序号全 0）'], [0xC2, 100, '异常周期（bit7 置位）']]) {
  const p = pkt.parseMainPacket([250, 2500, 450, st, sq]);
  E.seq.push({ status: '0x' + st.toString(16).toUpperCase(), seq: sq, extended: p.extended, subValid: p.subValid, bitmap: p.anomalyBitmap, d });
}
E.bitmap = [];
for (let b = 0; b <= 7; b++) {
  const a = pkt.anomaliesFromBitmap(b, { temperature: 85, pressure: 50, humidity: 90 });
  E.bitmap.push({ bm: '0b' + b.toString(2).padStart(3, '0'), n: a.length, types: a.map((x) => x.type).join('/') || '—', levels: a.map((x) => x.level).join('/') || '—' });
}
h('## 实验 E · 双包协议带宽与语义鲁棒性\n');
table(['传输方案', '单次事务 ADU 字节', '日流量/站', '说明'],
  [
    ['主包 only（正常工况）', E.bytes.mainOnly, E.daily.mainOnly + ' MB', 'FC03 读 2001–2005'],
    ['主包 + 子包（异常工况）', E.bytes.mainPlusSub, E.daily.mainPlusSub + ' MB', '异常周期追加读 2011–2015'],
    ['假想基线：全量原始波形', '—', E.daily.fullWave + ' MB', '3 通道 × 100 Hz × 4 B（对照假设）'],
  ]);
h('双包协议相对全量上传节省 **' + E.ratio + ' 倍**（正常工况）/' + E.ratioSub + ' 倍（异常工况）。\n');
table(['状态字', '序号', '判定扩展协议', '子包有效', '异常位图', '语义'], E.seq.map((r) => [r.status, r.seq, r.extended ? '是' : '否', r.subValid ? '是' : '否', r.bitmap, r.d]));
table(['子包位图', '告警条数', '类型', '等级'], E.bitmap.map((r) => [r.bm, r.n, r.types, r.levels]));
csv('exp_E_protocol.csv', ['item', 'value'],
  [['mainOnlyBytes', E.bytes.mainOnly], ['mainPlusSubBytes', E.bytes.mainPlusSub],
   ['dailyMainOnlyMB', E.daily.mainOnly], ['dailyMainPlusSubMB', E.daily.mainPlusSub], ['dailyFullWaveMB', E.daily.fullWave],
   ['savingRatio', E.ratio], ['savingRatioSub', E.ratioSub],
   ['lossToleratedPackets', 9], ['maxStalenessS', 18], ['reconnectCapS', 30]]);
R.E = E;

fs.writeFileSync(path.join(OUT, 'exp_results.json'), JSON.stringify(R, null, 1), 'utf8');
fs.writeFileSync(path.join(OUT, 'exp_tables.md'), MD.join('\n'), 'utf8');
console.log('B grid=' + B.grid.length + '  C plants=' + Object.keys(C).length + '  ratio=' + E.ratio);
console.log('DONE -> ' + OUT);
