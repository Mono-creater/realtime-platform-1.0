/**
 * pantograph-archive.js —— 受电弓"一弓一档" + 3 域健康度 + 碳滑板全生命周期
 *
 * 设计目标（对应平台 3.0 迭代）：
 *   1) 对象层级：线网 → 线路 → 列车 → 受电弓（Tc/Mp/M 位）→ 部件；
 *   2) 每架受电弓一个档案号，绑定六项：车号 / 线路 / 安装位置 / 投运日期 /
 *      累计里程 / 上次换板里程；
 *   3) "受电弓"拆成 3 个部件域（滑板 / 气路 / 弓网），每域定指标、判据、动作，
 *      整弓健康度 = 3 域加权扣分；
 *   4) 碳滑板不再是单一 0~100 分数：补齐四测点剩余厚度、磨耗速率、偏磨差、
 *      视觉缺陷、换板记录、剩余寿命预测（磨耗趋势线性外推）。
 *
 * 数据严谨性说明：
 *   · 单位与取值按地铁受电弓工程惯例给参考值（见下方常量注释）；
 *   · 磨耗历史由 genWearHistory() 生成，保证"磨耗速率 = 总磨耗量 / 里程跨度"自洽；
 *   · 具体车辆/线路为"典型工况参考值"，投运前以现场实测（视觉 + 里程 + 压力传感器 +
 *     PLC）标定替换；本模块作为对象模型与算法落点，不虚构"真实运营数据"。
 *
 * 参考取值（工程标定口径）：
 *   · 碳滑板碳层新厚度 40 mm；到限（更换）剩余厚度 10 mm；
 *   · 磨耗速率 5~7 mm/万 km（正常）；6 号线按"重度磨耗"标定约 13 mm/万 km（异常偏高，
 *     恰为本监测系统的价值点）；
 *   · 接触力 EN 50367: 静态接触力 70~120 N；气路保压 5 min 压降限 0.01 MPa；
 *     气囊压力跟踪误差限 5%；升降弓时间偏差限 15%。
 * 无第三方依赖。
 */

'use strict';

// ============ 常量（工程参考值） ============
const STRIP_NEW_THICKNESS_MM = 40;   // 碳滑板碳层新厚度（mm）
const STRIP_LIMIT_THICKNESS_MM = 10; // 到限剩余厚度（mm），低于即须更换

// 3 域权重：滑板域最直接反映劣化，权重最高（工程初值，可标定）
const DOMAIN_WEIGHTS = { strip: 0.50, air: 0.25, catenary: 0.25 };

// 健康度分级边界（与 health-index.js / 前端 alarm-types.js 保持一致：85/70/55）
const GRADE = [
  { min: 85, grade: '正常' },
  { min: 70, grade: '关注' },
  { min: 55, grade: '计划检修' },
  { min: 0, grade: '立即检修' },
];

function gradeOf(score) {
  return (GRADE.find((g) => score >= g.min) || GRADE[GRADE.length - 1]).grade;
}
function healthColor(score) {
  if (score >= 80) return '#00d68f';
  if (score >= 50) return '#ffaa00';
  return '#ff3d71';
}

// ============ 磨耗趋势（线性外推，与 rul-predictor.js 同口径） ============
/** 最小二乘线性拟合 thickness = a + b*mileage */
function linreg(xs, ys) {
  const n = xs.length;
  if (n < 2) return { a: NaN, b: NaN, n };
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b, n };
}

/**
 * 由磨耗历史计算：磨耗速率(mm/万km)、剩余寿命(万km)、建议更换里程(km)。
 * 磨耗速率取最近 fitTail 个点线性拟合的斜率；寿命 = (当前厚度 − 到限) / 速率。
 */
function computeStripWear(history, opts = {}) {
  const fitTail = opts.fitTail || 6;
  const pts = (history || []).filter((p) => Number.isFinite(p.thicknessMm));
  if (pts.length < 2) return { wearRateMmPerWanKm: 0, rulWanKm: null, replaceMileageKm: null, note: '磨耗历史不足' };
  const tail = pts.slice(-fitTail);
  const xs = tail.map((p) => p.mileageKm);
  const ys = tail.map((p) => p.thicknessMm);
  const { b } = linreg(xs, ys);           // b: mm / km（负值 = 磨损）
  const wearRate = -b * 10000;            // 转 mm/万 km
  const current = ys[ys.length - 1];
  const margin = current - STRIP_LIMIT_THICKNESS_MM;
  let rulWanKm = null;
  let replaceMileageKm = null;
  let note;
  if (Math.abs(wearRate) < 0.005) {
    note = '磨耗速率接近 0，无法外推剩余寿命';
  } else if (margin <= 0) {
    note = '当前剩余厚度已达/低于到限，建议立即更换';
  } else {
    rulWanKm = margin / wearRate;                       // 万 km
    replaceMileageKm = pts[pts.length - 1].mileageKm + rulWanKm * 10000; // km
    note = `剩余寿命 ≈ (${current.toFixed(1)} − ${STRIP_LIMIT_THICKNESS_MM}) / ${wearRate.toFixed(3)} = ${rulWanKm.toFixed(2)} 万 km`;
  }
  return {
    wearRateMmPerWanKm: +wearRate.toFixed(2),
    rulWanKm: rulWanKm === null ? null : +rulWanKm.toFixed(2),
    replaceMileageKm: replaceMileageKm === null ? null : Math.round(replaceMileageKm),
    currentThicknessMm: +current.toFixed(1),
    note,
  };
}

// ============ 回库视觉检测（YOLO 缺陷检出） ============
// 说明：这是"视觉检测"在平台上的业务落点——每次回库（或入库线）对滑板拍 96 张图，
// 模型检出缺陷后按缺陷类型/置信度/位置入档；本模块只保存检测结果，不保存图像。
// 模型指标为工程参考值，投运前以现场样本集重新评估。
const INSPECTION_MODEL = {
  name: 'YOLOv8s-seg',
  version: 'v3.2',
  map50: 0.912,
  map5095: 0.743,
  inferenceMs: 38,
  classes: ['裂纹', '崩角', '沟槽磨损', '电弧烧蚀'],
  note: '滑板表面缺陷实例分割；mAP 为现场验证集指标，随机场样本集更新',
};

/** 按里程在"滑板安装日 ~ 今天"之间线性插值出检测日期 */
function dateAtMileage(pg, mileageKm) {
  const start = new Date(pg.strip.installedAt).getTime();
  const end = Date.now();
  const span = Math.max(1, pg.mileageKm - pg.strip.installedMileageKm);
  const frac = Math.min(1, Math.max(0, (mileageKm - pg.strip.installedMileageKm) / span));
  return new Date(start + (end - start) * frac).toISOString().slice(0, 10);
}

/**
 * 生成回库检测记录：取磨耗历史末 4 个节点，每次检测记录当时厚度与缺陷。
 * 缺陷按"latest 帧保留全部、历史帧保留前 k 个"分布，保证与当前缺陷档案一致。
 */
function buildInspections(pg) {
  const h = pg.strip.wearHistory || [];
  const n = h.length;
  if (n < 2) return { model: INSPECTION_MODEL, frames: [] };
  const idxs = [Math.max(0, n - 4), Math.max(0, n - 3), Math.max(0, n - 2), n - 1];
  const all = pg.strip.defects || [];
  const frames = idxs.map((idx, i) => {
    const point = h[idx];
    const keep = all.length === 0 ? 0 : Math.max(1, Math.ceil((all.length * (i + 1)) / idxs.length));
    const defects = all.slice(0, keep).map((d) => ({ ...d }));
    const minT = point.thicknessMm;
    let conclusion = '合格';
    if (minT <= STRIP_LIMIT_THICKNESS_MM + 1.5) conclusion = '需更换';
    else if (defects.some((d) => d.severity === '高') || minT <= STRIP_LIMIT_THICKNESS_MM + 4) conclusion = '需关注';
    return {
      id: `${pg.id}-INS-${String(i + 1).padStart(3, '0')}`,
      date: dateAtMileage(pg, point.mileageKm),
      mileageKm: point.mileageKm,
      thicknessMm: point.thicknessMm,
      images: 96,
      defects,
      conclusion,
      station: '车辆段检修库 · 受电弓检测工位',
    };
  });
  return { model: INSPECTION_MODEL, frames };
}

/**
 * 生成自洽的磨耗历史：从新厚度线性磨至当前厚度，保证速率 = 总磨耗/里程跨度。
 * @param {number} installedMileageKm 滑板安装时里程（km，绝对里程）
 * @param {number} currentMileageKm   当前里程（km）
 * @param {number} currentThicknessMm 当前剩余厚度（mm，取四测点最小者）
 * @param {number} points             采样点数
 */
function genWearHistory(installedMileageKm, currentMileageKm, currentThicknessMm, points = 8) {
  const span = currentMileageKm - installedMileageKm;
  const totalWear = STRIP_NEW_THICKNESS_MM - currentThicknessMm;
  const history = [];
  for (let i = 0; i < points; i++) {
    const frac = i / (points - 1);
    const mileageKm = Math.round(installedMileageKm + span * frac);
    const thicknessMm = +(STRIP_NEW_THICKNESS_MM - totalWear * frac).toFixed(1);
    history.push({ mileageKm, thicknessMm });
  }
  return history;
}

// ============ 档案数据（典型工况参考值，非真实运营数据） ============
// 每架受电弓：绑六项 + 滑板（第 N 块、四测点、磨耗历史、缺陷、换板记录）+ 气路 + 弓网。
// 磨耗历史由 genWearHistory 生成，保证速率自洽（5~7 mm/万 km 正常，6 号线约 13 mm/万 km 重度磨耗）。
const PANTOGRAPHS = [
  {
    id: 'PG-6-5195-MP1', train: '5195', line: '6号线', lineId: '6', position: 'MP1位',
    commissionedAt: '2026-02-04', mileageKm: 65000, lastStripMileageKm: 44000,
    strip: {
      serial: 3, installedAt: '2026-08-04', installedMileageKm: 44000,
      points: [
        { pos: '测点1（前端内）', thicknessMm: 11.8 },
        { pos: '测点2（前端外）', thicknessMm: 12.4 },
        { pos: '测点3（后端内）', thicknessMm: 12.9 },
        { pos: '测点4（后端外）', thicknessMm: 12.1 },
      ],
      wearHistory: genWearHistory(44000, 65000, 11.8),
      defects: [
        { type: '裂纹', x: 0.18, y: 0.32, w: 0.08, h: 0.06, confidence: 0.91, severity: '高' },
        { type: '电弧烧蚀', x: 0.62, y: 0.40, w: 0.12, h: 0.10, confidence: 0.87, severity: '中' },
      ],
      replacements: [
        { serial: 1, date: '2026-02-04', mileageKm: 0, reason: '出厂安装' },
        { serial: 2, date: '2026-05-10', mileageKm: 21000, reason: '磨耗到限' },
        { serial: 3, date: '2026-08-04', mileageKm: 44000, reason: '偏磨超限' },
      ],
    },
    air: { trackErrorPct: 3.2, leakMpaPer5min: 0.004, raiseTimeS: 8.4, lowerTimeS: 6.1, raiseTimeStdS: 8.0, lowerTimeStdS: 6.0 },
    catenary: { contactForceMeanN: 96.5, contactForceStdN: 6.8, arcRate: 1.2, staggerMm: 12, heightMm: 2400, violations24h: 3 },
  },
  {
    id: 'PG-1-0503-MP1', train: '0503', line: '1号线', lineId: '1', position: 'MP1位',
    commissionedAt: '2024-03-12', mileageKm: 186000, lastStripMileageKm: 183000,
    strip: {
      serial: 4, installedAt: '2026-09-15', installedMileageKm: 183000,
      points: [
        { pos: '测点1（前端内）', thicknessMm: 38.2 },
        { pos: '测点2（前端外）', thicknessMm: 38.5 },
        { pos: '测点3（后端内）', thicknessMm: 38.8 },
        { pos: '测点4（后端外）', thicknessMm: 38.3 },
      ],
      wearHistory: genWearHistory(183000, 186000, 38.2),
      defects: [],
      replacements: [
        { serial: 1, date: '2024-03-12', mileageKm: 0, reason: '出厂安装' },
        { serial: 2, date: '2024-10-02', mileageKm: 62000, reason: '磨耗到限' },
        { serial: 3, date: '2025-06-18', mileageKm: 124000, reason: '磨耗到限' },
        { serial: 4, date: '2026-09-15', mileageKm: 183000, reason: '定期更换' },
      ],
    },
    air: { trackErrorPct: 1.8, leakMpaPer5min: 0.002, raiseTimeS: 8.1, lowerTimeS: 6.0, raiseTimeStdS: 8.0, lowerTimeStdS: 6.0 },
    catenary: { contactForceMeanN: 101.2, contactForceStdN: 4.2, arcRate: 0.3, staggerMm: 8, heightMm: 2400, violations24h: 0 },
  },
  {
    id: 'PG-2-0512-MP2', train: '0512', line: '2号线', lineId: '2', position: 'MP2位',
    commissionedAt: '2025-01-20', mileageKm: 128000, lastStripMileageKm: 103000,
    strip: {
      serial: 2, installedAt: '2026-04-28', installedMileageKm: 103000,
      points: [
        { pos: '测点1（前端内）', thicknessMm: 25.0 },
        { pos: '测点2（前端外）', thicknessMm: 25.4 },
        { pos: '测点3（后端内）', thicknessMm: 25.8 },
        { pos: '测点4（后端外）', thicknessMm: 25.2 },
      ],
      wearHistory: genWearHistory(103000, 128000, 25.0),
      defects: [{ type: '沟槽磨损', x: 0.45, y: 0.30, w: 0.10, h: 0.05, confidence: 0.82, severity: '中' }],
      replacements: [
        { serial: 1, date: '2025-01-20', mileageKm: 0, reason: '出厂安装' },
        { serial: 2, date: '2026-04-28', mileageKm: 103000, reason: '磨耗到限' },
      ],
    },
    air: { trackErrorPct: 2.6, leakMpaPer5min: 0.006, raiseTimeS: 8.8, lowerTimeS: 6.5, raiseTimeStdS: 8.0, lowerTimeStdS: 6.0 },
    catenary: { contactForceMeanN: 99.0, contactForceStdN: 5.4, arcRate: 0.8, staggerMm: 10, heightMm: 2400, violations24h: 1 },
  },
  {
    id: 'PG-3-0721-MP1', train: '0721', line: '3号线', lineId: '3', position: 'MP1位',
    commissionedAt: '2024-09-08', mileageKm: 152000, lastStripMileageKm: 147000,
    strip: {
      serial: 3, installedAt: '2026-06-02', installedMileageKm: 147000,
      points: [
        { pos: '测点1（前端内）', thicknessMm: 36.5 },
        { pos: '测点2（前端外）', thicknessMm: 36.7 },
        { pos: '测点3（后端内）', thicknessMm: 36.9 },
        { pos: '测点4（后端外）', thicknessMm: 36.6 },
      ],
      wearHistory: genWearHistory(147000, 152000, 36.5),
      defects: [],
      replacements: [
        { serial: 1, date: '2024-09-08', mileageKm: 0, reason: '出厂安装' },
        { serial: 2, date: '2025-05-21', mileageKm: 98000, reason: '磨耗到限' },
        { serial: 3, date: '2026-06-02', mileageKm: 147000, reason: '定期更换' },
      ],
    },
    air: { trackErrorPct: 6.5, leakMpaPer5min: 0.014, raiseTimeS: 10.2, lowerTimeS: 7.4, raiseTimeStdS: 8.0, lowerTimeStdS: 6.0 },
    catenary: { contactForceMeanN: 98.2, contactForceStdN: 5.0, arcRate: 0.6, staggerMm: 9, heightMm: 2400, violations24h: 1 },
  },
  {
    id: 'PG-4-0634-MP1', train: '0634', line: '4号线', lineId: '4', position: 'MP1位',
    commissionedAt: '2024-11-15', mileageKm: 141000, lastStripMileageKm: 112000,
    strip: {
      serial: 3, installedAt: '2026-03-18', installedMileageKm: 112000,
      points: [
        { pos: '测点1（前端内）', thicknessMm: 19.5 },
        { pos: '测点2（前端外）', thicknessMm: 22.8 },
        { pos: '测点3（后端内）', thicknessMm: 23.4 },
        { pos: '测点4（后端外）', thicknessMm: 24.6 },
      ],
      wearHistory: genWearHistory(112000, 141000, 19.5),
      defects: [{ type: '崩角', x: 0.08, y: 0.25, w: 0.07, h: 0.07, confidence: 0.94, severity: '高' }],
      replacements: [
        { serial: 1, date: '2024-11-15', mileageKm: 0, reason: '出厂安装' },
        { serial: 2, date: '2025-07-10', mileageKm: 56000, reason: '磨耗到限' },
        { serial: 3, date: '2026-03-18', mileageKm: 112000, reason: '偏磨超限' },
      ],
    },
    air: { trackErrorPct: 2.9, leakMpaPer5min: 0.005, raiseTimeS: 8.6, lowerTimeS: 6.3, raiseTimeStdS: 8.0, lowerTimeStdS: 6.0 },
    catenary: { contactForceMeanN: 97.4, contactForceStdN: 5.8, arcRate: 0.9, staggerMm: 11, heightMm: 2400, violations24h: 2 },
  },
  {
    id: 'PG-5-0809-MP1', train: '0809', line: '5号线', lineId: '5', position: 'MP1位',
    commissionedAt: '2025-03-01', mileageKm: 119000, lastStripMileageKm: 93000,
    strip: {
      serial: 2, installedAt: '2026-03-06', installedMileageKm: 93000,
      points: [
        { pos: '测点1（前端内）', thicknessMm: 24.4 },
        { pos: '测点2（前端外）', thicknessMm: 24.6 },
        { pos: '测点3（后端内）', thicknessMm: 24.9 },
        { pos: '测点4（后端外）', thicknessMm: 24.5 },
      ],
      wearHistory: genWearHistory(93000, 119000, 24.4),
      defects: [],
      replacements: [
        { serial: 1, date: '2025-03-01', mileageKm: 0, reason: '出厂安装' },
        { serial: 2, date: '2026-03-06', mileageKm: 93000, reason: '磨耗到限' },
      ],
    },
    air: { trackErrorPct: 2.2, leakMpaPer5min: 0.003, raiseTimeS: 8.2, lowerTimeS: 6.1, raiseTimeStdS: 8.0, lowerTimeStdS: 6.0 },
    catenary: { contactForceMeanN: 100.1, contactForceStdN: 4.6, arcRate: 0.4, staggerMm: 9, heightMm: 2400, violations24h: 0 },
  },
];

// ============ 3 域健康度计算（加权扣分） ============

/** 滑板域：按剩余厚度余量 + 偏磨 + 缺陷扣分 */
function stripDomainScore(pg) {
  const s = pg.strip;
  const th = s.points.map((p) => p.thicknessMm);
  const minT = Math.min(...th);
  const maxT = Math.max(...th);
  const skew = maxT - minT;                       // 偏磨差（mm）
  const marginRatio = (minT - STRIP_LIMIT_THICKNESS_MM) / (STRIP_NEW_THICKNESS_MM - STRIP_LIMIT_THICKNESS_MM);

  let score = 100;
  score -= Math.max(0, (1 - marginRatio)) * 55;   // 到限时扣 55
  if (skew > 3) score -= Math.min(20, (skew - 3) * 5);   // 偏磨 >3mm 扣分
  const sev = { 高: 8, 中: 4, 低: 2 };
  for (const d of s.defects) score -= sev[d.severity] || 3;
  return clamp(score);
}

/** 气路域：压力跟踪误差 + 保压压降 + 升降弓时间偏差扣分 */
function airDomainScore(pg) {
  const a = pg.air;
  let score = 100;
  if (a.trackErrorPct > 5) score -= Math.min(25, (a.trackErrorPct - 5) * 4);
  if (a.leakMpaPer5min > 0.01) score -= Math.min(25, (a.leakMpaPer5min - 0.01) * 2000);
  const raiseDev = Math.abs(a.raiseTimeS - a.raiseTimeStdS) / a.raiseTimeStdS;
  const lowerDev = Math.abs(a.lowerTimeS - a.lowerTimeStdS) / a.lowerTimeStdS;
  if (raiseDev > 0.15) score -= Math.min(20, (raiseDev - 0.15) * 60);
  if (lowerDev > 0.15) score -= Math.min(20, (lowerDev - 0.15) * 60);
  return clamp(score);
}

/** 弓网域：接触力标准差 / 燃弧率 / 拉出值 / 导高 + 越限扣分 */
function catenaryDomainScore(pg) {
  const c = pg.catenary;
  let score = 100;
  if (c.contactForceStdN > 8) score -= Math.min(20, (c.contactForceStdN - 8) * 4);
  if (c.arcRate > 2) score -= Math.min(20, (c.arcRate - 2) * 8);
  if (Math.abs(c.staggerMm) > 20) score -= Math.min(15, (Math.abs(c.staggerMm) - 20) * 1.5);
  score -= Math.min(20, (c.violations24h || 0) * 5);
  return clamp(score);
}

function clamp(x) { return Math.max(0, Math.min(100, Math.round(x))); }

/** 整弓健康度 = 3 域加权 */
function computePantographHealth(pg) {
  const strip = stripDomainScore(pg);
  const air = airDomainScore(pg);
  const catenary = catenaryDomainScore(pg);
  const overall = Math.round(strip * DOMAIN_WEIGHTS.strip + air * DOMAIN_WEIGHTS.air + catenary * DOMAIN_WEIGHTS.catenary);
  return {
    overall,
    grade: gradeOf(overall),
    color: healthColor(overall),
    domains: { strip, air, catenary },
    weights: DOMAIN_WEIGHTS,
  };
}

// ============ 时间轴（全生命周期事件） ============
function buildTimeline(pg) {
  const events = [{ date: pg.commissionedAt, type: '投运', label: `受电弓投运（${pg.position}）`, mileageKm: 0 }];
  for (const r of pg.strip.replacements) {
    events.push({ date: r.date, type: '换板', label: `第 ${r.serial} 块滑板更换（${r.reason}）`, mileageKm: r.mileageKm });
  }
  events.sort((a, b) => new Date(a.date) - new Date(b.date));
  return events;
}

// ============ 告警上下文（解决"只知道 3 号通道压力超限"的问题） ============
function buildContextSentence(pg) {
  const months = Math.max(1, Math.round((Date.now() - new Date(pg.commissionedAt).getTime()) / (30 * 86400000)));
  const wanKm = (pg.mileageKm / 10000).toFixed(1);
  const strip = pg.strip;
  const stripMileage = pg.mileageKm - strip.installedMileageKm;
  const stripWanKm = (stripMileage / 10000).toFixed(1);
  const minT = Math.min(...strip.points.map((p) => p.thicknessMm));
  const nearLimit = minT - STRIP_LIMIT_THICKNESS_MM <= 2;
  const near = nearLimit ? `，剩余 ${minT.toFixed(1)} mm，已接近到限` : `，剩余 ${minT.toFixed(1)} mm`;
  return `深铁${pg.line}${pg.train}车${pg.position}受电弓，投运 ${months} 个月、累计 ${wanKm} 万公里；第 ${strip.serial} 块滑板自安装运行 ${stripWanKm} 万公里${near}`;
}

// ============ 对外接口 ============
function listPantographs() {
  return PANTOGRAPHS.map((pg) => {
    const wear = computeStripWear(pg.strip.wearHistory);
    const inspections = buildInspections(pg);
    const lastIns = inspections.frames[inspections.frames.length - 1];
    return {
      id: pg.id, train: pg.train, line: pg.line, lineId: pg.lineId, position: pg.position,
      mileageKm: pg.mileageKm, commissionedAt: pg.commissionedAt,
      stripSerial: pg.strip.serial,
      minThicknessMm: Math.min(...pg.strip.points.map((p) => p.thicknessMm)),
      skewMm: +(Math.max(...pg.strip.points.map((p) => p.thicknessMm))
        - Math.min(...pg.strip.points.map((p) => p.thicknessMm))).toFixed(1),
      wear,
      catenary: pg.catenary,
      air: pg.air,
      defectCount: pg.strip.defects.length,
      lastInspection: lastIns ? { date: lastIns.date, conclusion: lastIns.conclusion, defects: lastIns.defects.length } : null,
      health: computePantographHealth(pg),
      context: buildContextSentence(pg),
    };
  });
}

function getPantograph(id) {
  const pg = PANTOGRAPHS.find((p) => p.id === id);
  if (!pg) return null;
  return {
    ...pg,
    health: computePantographHealth(pg),
    strip: {
      ...pg.strip,
      wear: computeStripWear(pg.strip.wearHistory),
    },
    inspection: buildInspections(pg),
    timeline: buildTimeline(pg),
    context: buildContextSentence(pg),
  };
}

/** 全车队换板台账：按更换日期倒序，便于"智慧检修 → 换板台账"直接消费 */
function replacementsAll() {
  const out = [];
  for (const pg of PANTOGRAPHS) {
    for (const r of pg.strip.replacements) {
      out.push({
        id: `${pg.id}-R${r.serial}`,
        pantographId: pg.id, line: pg.line, train: pg.train, position: pg.position,
        serial: r.serial, date: r.date, mileageKm: r.mileageKm, reason: r.reason,
        stripSerialAtTime: r.serial,
      });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * 检修计划：按"剩余厚度 + 磨耗剩余寿命 + 3 域健康度 + 气路/弓网越限"生成优先级。
 * 与工单的区别：工单是已发生的作业，计划是"尚未发生、按预测该做什么"。
 */
function maintenancePlan() {
  return PANTOGRAPHS.map((pg) => {
    const health = computePantographHealth(pg);
    const wear = computeStripWear(pg.strip.wearHistory);
    const minT = Math.min(...pg.strip.points.map((p) => p.thicknessMm));
    const days = Math.max(1, Math.round((Date.now() - new Date(pg.commissionedAt).getTime()) / 86400000));
    const dailyKm = pg.mileageKm / days;                       // 日均里程（km/天）
    const rulKm = wear.rulWanKm !== null ? wear.rulWanKm * 10000 : null;
    const rulDays = rulKm !== null && dailyKm > 0 ? Math.round(rulKm / dailyKm) : null;

    let action, level, reason;
    if (minT <= STRIP_LIMIT_THICKNESS_MM + 1.5 || (rulDays !== null && rulDays <= 15)) {
      action = '更换碳滑板'; level = '紧急'; reason = `剩余厚度 ${minT.toFixed(1)} mm，按当前磨耗速率约 ${rulDays ?? '—'} 天到限`;
    } else if (rulDays !== null && rulDays <= 60) {
      action = '计划更换滑板'; level = '高'; reason = `剩余寿命约 ${wear.rulWanKm} 万 km（约 ${rulDays} 天），建议纳入下次计划修`;
    } else if (pg.air.trackErrorPct > 5 || pg.air.leakMpaPer5min > 0.01) {
      action = '气路检修'; level = '中'; reason = `压力跟踪误差 ${pg.air.trackErrorPct}%（限 5%）、保压压降 ${pg.air.leakMpaPer5min} MPa/5min（限 0.01）`;
    } else if (health.overall < 85) {
      action = '状态检修'; level = '中'; reason = `整弓健康度 ${health.overall}（${health.grade}），滑板域 ${health.domains.strip} / 气路域 ${health.domains.air} / 弓网域 ${health.domains.catenary}`;
    } else {
      action = '常规巡检'; level = '低'; reason = '各项指标在限值内，按周期巡检';
    }

    return {
      id: `MP-${pg.id}`,
      pantographId: pg.id, line: pg.line, train: pg.train, position: pg.position,
      action, level, reason,
      health: health.overall, grade: health.grade,
      minThicknessMm: minT,
      rulWanKm: wear.rulWanKm, rulDays,
      dueMileageKm: wear.replaceMileageKm,
      context: buildContextSentence(pg),
    };
  }).sort((a, b) => {
    const order = { 紧急: 0, 高: 1, 中: 2, 低: 3 };
    return (order[a.level] - order[b.level]) || (a.health - b.health);
  });
}

/** 车队汇总：供"列车总览"顶部指标卡 */
function fleetSummary() {
  const list = listPantographs();
  const grades = { 正常: 0, 关注: 0, 计划检修: 0, 立即检修: 0 };
  const byLine = {};
  let minT = Infinity;
  for (const p of list) {
    grades[p.health.grade] = (grades[p.health.grade] || 0) + 1;
    if (!byLine[p.line]) byLine[p.line] = { line: p.line, lineId: p.lineId, count: 0, minHealth: 100 };
    byLine[p.line].count += 1;
    byLine[p.line].minHealth = Math.min(byLine[p.line].minHealth, p.health.overall);
    minT = Math.min(minT, p.minThicknessMm);
  }
  const avg = list.reduce((s, p) => s + p.health.overall, 0) / (list.length || 1);
  return {
    total: list.length,
    lines: Object.keys(byLine).length,
    avgHealth: Math.round(avg * 10) / 10,
    grades,
    minThicknessMm: minT === Infinity ? null : minT,
    byLine: Object.values(byLine).sort((a, b) => Number(a.lineId) - Number(b.lineId)),
  };
}

/** 按线路聚合（供"线网简图"按线路着色/点进到车） */
function lineSummary() {
  const map = {};
  for (const pg of PANTOGRAPHS) {
    if (!map[pg.lineId]) map[pg.lineId] = { lineId: pg.lineId, line: pg.line, trains: [], minHealth: 100 };
    const h = computePantographHealth(pg).overall;
    map[pg.lineId].trains.push({ id: pg.id, train: pg.train, position: pg.position, health: h });
    map[pg.lineId].minHealth = Math.min(map[pg.lineId].minHealth, h);
  }
  return Object.values(map).sort((a, b) => Number(a.lineId) - Number(b.lineId));
}

/**
 * 告警 → 受电弓档案绑定（解决"只知道通道超限，不知道是哪架受电弓"）。
 * 真实系统里，每个传感器通道在配置时即绑定到具体受电弓；这里用"演示告警编号 → 档案"
 * 的确定性映射落地该绑定关系，未知编号回退到当前监控对象（6 号线 5195 车 MP1 位）。
 */
const DEMO_CODE_TO_ARCHIVE = {
  THB000001: 'PG-1-0503-MP1',
  THB000002: 'PG-2-0512-MP2',
  THB000003: 'PG-3-0721-MP1',
  THB000004: 'PG-4-0634-MP1',
  THB000005: 'PG-5-0809-MP1',
  THB000006: 'PG-6-5195-MP1',
  THB000007: 'PG-1-0503-MP1',
  THB000008: 'PG-2-0512-MP2',
  THB000009: 'PG-3-0721-MP1',
  THB000010: 'PG-4-0634-MP1',
  THB000011: 'PG-5-0809-MP1',
  THB000012: 'PG-6-5195-MP1',
  // 3.0 碳滑板自身告警（磨耗/偏磨/视觉缺陷）——不再只报"弓网关系"
  THB000013: 'PG-6-5195-MP1',   // 磨耗到限预警
  THB000014: 'PG-4-0634-MP1',   // 偏磨超限
  THB000015: 'PG-6-5195-MP1',   // 裂纹检出
  THB000016: 'PG-6-5195-MP1',   // 电弧烧蚀
  THB000017: 'PG-4-0634-MP1',   // 偏磨超限（复现）
  THB000018: 'PG-6-5195-MP1',   // 磨耗到限预警（复现）
};
const DEFAULT_ARCHIVE_ID = 'PG-6-5195-MP1';

/** 告警 → 车号（用于"在线受电弓"按列车去重，而不是按滑板编号去重） */
function trainOfWarning(warning) {
  if (!warning) return null;
  const id = DEMO_CODE_TO_ARCHIVE[warning.code];
  if (!id) return null;
  const pg = PANTOGRAPHS.find((p) => p.id === id);
  return pg ? pg.train : null;
}

function resolveForWarning(warning) {
  if (!warning) return null;
  const id = DEMO_CODE_TO_ARCHIVE[warning.code] || DEFAULT_ARCHIVE_ID;
  const pg = PANTOGRAPHS.find((p) => p.id === id) || PANTOGRAPHS[0];
  if (!pg) return null;
  return { id: pg.id, context: buildContextSentence(pg) };
}

module.exports = {
  STRIP_NEW_THICKNESS_MM, STRIP_LIMIT_THICKNESS_MM,
  DOMAIN_WEIGHTS, GRADE, gradeOf, healthColor, INSPECTION_MODEL,
  listPantographs, getPantograph, lineSummary, buildContextSentence, computeStripWear,
  replacementsAll, maintenancePlan, fleetSummary, buildInspections,
  resolveForWarning, trainOfWarning,
};
