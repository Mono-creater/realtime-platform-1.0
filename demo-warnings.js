/**
 * demo-warnings.js —— 受电弓告警演示数据（12 条，覆盖 4 类部件告警 × 近 7 天）
 *
 * 背景：平台原内置 6 条演示记录，后于 2026-08-27 连同饼图/统计初值一并清除
 * （见 server.js 顶部注释），源码与数据库中均已不存在。本次按原设计口径重建，
 * 3.0 扩为 12 条并分散在近 7 天，使总览页"今日告警 / 近 7 天趋势 / 类型分布"始终有数据。
 *
 * 设计要点：
 *  1) 覆盖全部四种受电弓部件告警（压力/导高/燃弧/拉出值），分布不均衡，
 *     便于饼图与趋势图有可辨识的形态；
 *  2) 时间相对"当前时刻"按小时偏移生成，而非硬编码绝对日期——server.js 每次启动
 *     都会 clearDemoWarnings + seedDemoWarnings 重灌，保证任何时候都新鲜；
 *  3) 备注在库内统一带 [演示数据] 标记，作为幂等与清理的判定依据；
 *     该标记**仅供内部使用**，对外（前端/导出）由 stripDemoMark() 剥除后再展示。
 *  4) 碳滑板编号 THB000001~THB000012，与 pantograph-archive.js 的受电弓档案一一对应。
 *
 * 幂等：以 remark 中的 [演示数据] 标记判重；清理：clearDemoWarnings() 仅删除带标记记录。
 */

const DEMO_MARK = '[演示数据]';

/** 相对当前时刻的小时偏移（负值表示过去）：前 4 条落在今日，其余分散在近 7 天 */
const HOURS_AGO = [2, 6, 9, 14, 23, 34, 48, 62, 78, 96, 120, 150, 5, 18, 42, 66, 90, 112];

/**
 * 12 条演示告警定义。hoursAgo 为小时偏移，其余字段为业务属性；
 * 时间在 buildDemoWarnings() 中动态换算。
 */
const DEMO_DEFS = [
  { code: 'THB000001', content: '压力超限', worker: 'WX-1234', hoursAgo: HOURS_AGO[0], remark: '接触力峰值超上限，建议检查弓头压力与碳滑板贴合度' },
  { code: 'THB000002', content: '压力超限', worker: 'WX-5678', hoursAgo: HOURS_AGO[1], remark: '压力波动幅度偏大，疑似气路不稳，需复核压力传感器标定' },
  { code: 'THB000003', content: '压力超限', worker: 'WX-9012', hoursAgo: HOURS_AGO[2], remark: '3 号通道压力持续超限，疑似比例阀卡滞，建议核查气路' },
  { code: 'THB000004', content: '导高超限', worker: 'WX-3456', hoursAgo: HOURS_AGO[3], remark: '弓头高度偏离设定值，超出允许误差带' },
  { code: 'THB000005', content: '导高超限', worker: 'WX-4567', hoursAgo: HOURS_AGO[4], remark: '弓头高度瞬时抖动，疑似接触网坡度变化导致' },
  { code: 'THB000006', content: '导高超限', worker: 'WX-6789', hoursAgo: HOURS_AGO[5], remark: '高度越限持续 12 秒，已触发降弓保护' },
  { code: 'THB000007', content: '燃弧超限', worker: 'WX-2345', hoursAgo: HOURS_AGO[6], remark: '取流中断伴燃弧，建议检查碳滑板磨耗与接触网对位' },
  { code: 'THB000008', content: '燃弧超限', worker: 'WX-6780', hoursAgo: HOURS_AGO[7], remark: '重复燃弧累计超限，建议安排碳滑板更换' },
  { code: 'THB000009', content: '燃弧超限', worker: 'WX-1122', hoursAgo: HOURS_AGO[8], remark: '过电分相燃弧偏多，建议关注弓网接触质量' },
  { code: 'THB000010', content: '拉出值超限', worker: 'WX-3344', hoursAgo: HOURS_AGO[9], remark: '拉出值偏移超限，影响受流稳定性' },
  { code: 'THB000011', content: '拉出值超限', worker: 'WX-5566', hoursAgo: HOURS_AGO[10], remark: '之字运动拉出值瞬时越限，建议复测导高拉出值' },
  { code: 'THB000012', content: '拉出值超限', worker: 'WX-7788', hoursAgo: HOURS_AGO[11], remark: '曲线区段拉出值越限，与受电弓横向摆幅相关' },

  // ---- 3.0 新增：碳滑板自身状态告警（不再只有"弓网关系"）----
  // 口径：磨耗到限/偏磨来自厚度测量与磨耗预测；裂纹/电弧烧蚀来自回库视觉检测（YOLO）。
  { code: 'THB000013', content: '磨耗到限预警', worker: 'WX-2233', hoursAgo: HOURS_AGO[12], remark: '第 3 块滑板剩余 11.8 mm，按 13.4 mm/万km 磨耗速率约 5 天到限，建议入库更换' },
  { code: 'THB000014', content: '偏磨超限', worker: 'WX-4455', hoursAgo: HOURS_AGO[13], remark: '四测点偏磨差 5.1 mm（限 3 mm），前端内侧磨耗偏快，建议检查弓头水平度' },
  { code: 'THB000015', content: '裂纹检出', worker: 'WX-2233', hoursAgo: HOURS_AGO[14], remark: '回库视觉检测检出裂纹（置信度 0.91），位于滑板前端内侧，建议复检确认' },
  { code: 'THB000016', content: '电弧烧蚀', worker: 'WX-6677', hoursAgo: HOURS_AGO[15], remark: '回库视觉检测检出电弧烧蚀（置信度 0.87），面积约滑板宽度 12%，建议打磨或更换' },
  { code: 'THB000017', content: '偏磨超限', worker: 'WX-4455', hoursAgo: HOURS_AGO[16], remark: '同一滑板 7 日内二次偏磨超限，偏磨差 5.1 mm，建议更换并复查弓头几何' },
  { code: 'THB000018', content: '磨耗到限预警', worker: 'WX-2233', hoursAgo: HOURS_AGO[17], remark: '磨耗速率 13.4 mm/万km 超基线 2 倍，剩余寿命不足 0.2 万km，建议纳入紧急计划' },
];

/**
 * 演示告警的运行上下文（车号/线路/区站/行别/定位点号/公里标/速度）。
 * 车号与线路与 pantograph-archive.js 的受电弓档案一一对应（6 号线旗舰 5195）。
 */
const DEMO_CONTEXT = {
  THB000001: { carNumber: '0503', line: '1号线', station: '岗厦至会展中心', direction: '上行', location: 'RC05-012', mileage: 'K8+120',  speed: 62 },
  THB000002: { carNumber: '0512', line: '2号线', station: '车公庙至香蜜湖', direction: '下行', location: 'RC08-134', mileage: 'K15+406', speed: 55 },
  THB000003: { carNumber: '0721', line: '3号线', station: '福田至少年宫',   direction: '上行', location: 'RC12-078', mileage: 'K21+933', speed: 68 },
  THB000004: { carNumber: '0634', line: '4号线', station: '会展中心至购物公园', direction: '下行', location: 'RC03-245', mileage: 'K5+277', speed: 74 },
  THB000005: { carNumber: '0809', line: '5号线', station: '布吉至百鸽笼',   direction: '上行', location: 'RC15-091', mileage: 'K28+642', speed: 58 },
  THB000006: { carNumber: '5195', line: '6号线', station: '深圳北至长湖',   direction: '下行', location: 'RC09-160', mileage: 'K18+089', speed: 65 },
  THB000007: { carNumber: '0503', line: '1号线', station: '会展中心至购物公园', direction: '下行', location: 'RC05-240', mileage: 'K9+410', speed: 60 },
  THB000008: { carNumber: '0512', line: '2号线', station: '香蜜湖至安托山', direction: '上行', location: 'RC08-300', mileage: 'K17+020', speed: 53 },
  THB000009: { carNumber: '0721', line: '3号线', station: '少年宫至莲花村', direction: '上行', location: 'RC12-200', mileage: 'K23+150', speed: 66 },
  THB000010: { carNumber: '0634', line: '4号线', station: '购物公园至福民', direction: '下行', location: 'RC03-400', mileage: 'K6+880', speed: 71 },
  THB000011: { carNumber: '0809', line: '5号线', station: '百鸽笼至布心',   direction: '下行', location: 'RC15-260', mileage: 'K30+110', speed: 57 },
  THB000012: { carNumber: '5195', line: '6号线', station: '长湖至观澜',     direction: '上行', location: 'RC09-300', mileage: 'K20+560', speed: 63 },
  // 碳滑板自身告警上下文（磨耗/偏磨/视觉缺陷）
  THB000013: { carNumber: '5195', line: '6号线', station: '深圳北至长湖',   direction: '下行', location: 'RC09-160', mileage: 'K18+089', speed: 65 },
  THB000014: { carNumber: '0634', line: '4号线', station: '会展中心至购物公园', direction: '下行', location: 'RC03-245', mileage: 'K5+277',  speed: 74 },
  THB000015: { carNumber: '5195', line: '6号线', station: '深圳北至长湖',   direction: '下行', location: 'RC09-160', mileage: 'K18+089', speed: 65 },
  THB000016: { carNumber: '5195', line: '6号线', station: '深圳北至长湖',   direction: '下行', location: 'RC09-160', mileage: 'K18+089', speed: 65 },
  THB000017: { carNumber: '0634', line: '4号线', station: '购物公园至福民', direction: '下行', location: 'RC03-400', mileage: 'K6+880',  speed: 71 },
  THB000018: { carNumber: '5195', line: '6号线', station: '长湖至观澜',     direction: '上行', location: 'RC09-300', mileage: 'K20+560', speed: 63 },
};

/** 按记录取演示上下文：仅对带 [演示数据] 标记且编号命中的记录生效 */
function demoContextFor(warning) {
  if (!warning || !warning.remark || !String(warning.remark).startsWith(DEMO_MARK)) return null;
  return DEMO_CONTEXT[warning.code] || null;
}

/**
 * 去掉备注开头的 [演示数据] 标记 —— **仅用于对外展示**。
 */
function stripDemoMark(remark) {
  if (remark == null) return remark;
  const s = String(remark);
  if (!s.startsWith(DEMO_MARK)) return s;
  return s.slice(DEMO_MARK.length).replace(/^\s+/, '');
}

/** 批量：对记录数组去标记（返回新对象，不修改入参） */
function stripDemoMarkOf(warning) {
  if (!warning || warning.remark == null) return warning;
  return { ...warning, remark: stripDemoMark(warning.remark) };
}

/** 构造 12 条演示告警记录（时间为当前时刻按小时偏移换算） */
function buildDemoWarnings() {
  const now = Date.now();
  return DEMO_DEFS.map((d) => ({
    code: d.code,
    content: d.content,
    time: new Date(now - d.hoursAgo * 3600 * 1000),
    worker: d.worker,
    remark: `${DEMO_MARK} ${d.remark}`,
  }));
}

/**
 * 将演示告警写入数据库。
 * @param {PrismaClient} prisma  已初始化的 Prisma 客户端
 * @returns {Promise<number>} 本次实际写入的条数
 */
async function seedDemoWarnings(prisma) {
  if (!prisma) return 0;
  const records = buildDemoWarnings();
  let inserted = 0;
  for (const r of records) {
    const exists = await prisma.warningHistory.findFirst({
      where: { code: r.code, remark: { startsWith: DEMO_MARK } },
    });
    if (exists) continue;
    await prisma.warningHistory.create({ data: r });
    inserted += 1;
  }
  return inserted;
}

/**
 * 清理全部演示告警（仅删除带 [演示数据] 标记的记录）。
 * @returns {Promise<number>} 删除条数
 */
async function clearDemoWarnings(prisma) {
  if (!prisma) return 0;
  const res = await prisma.warningHistory.deleteMany({
    where: { remark: { startsWith: DEMO_MARK } },
  });
  return res.count;
}

module.exports = {
    DEMO_MARK, DEMO_DEFS, DEMO_CONTEXT,
    demoContextFor, stripDemoMark, stripDemoMarkOf,
    buildDemoWarnings, seedDemoWarnings, clearDemoWarnings,
};
