/**
 * alarm-types.js —— 受电弓告警类型口径（单一来源）
 *
 * 背景：平台存在三类性质不同的告警此前混在同一条数据流里展示，导致口径矛盾——
 *   1) 弓网关系告警：压力超限、导高超限、燃弧超限、拉出值超限。
 *      看的是"弓与网"的配合，不是碳滑板本身。
 *   2) 碳滑板自身告警（3.0 新增）：磨耗到限预警、偏磨超限、裂纹检出、电弧烧蚀。
 *      前两类来自厚度测量 + 磨耗预测，后两类来自回库视觉检测（YOLO）。
 *   3) 环境/传感器通道告警：高温预警、低温预警、高湿预警、高压报警、低压报警。
 *      它们由环境温度、湿度、气囊压力等外部条件引起，反映的是线路环境与气路状态，
 *      不反映碳滑板自身状态，因而不应出现在受电弓详情页、也不参与健康度扣减。
 *
 * 后端口径见 server.js 的 ENV_WARNING_CONTENTS / ENV_WARNING_CAUSES；
 * 前端所有页面统一从此处取，避免各页面各写一份常量而逐渐漂移。
 */

/**
 * 弓网关系告警：接触力 / 导高 / 燃弧 / 拉出值，反映的是"弓与网"的配合状态。
 * 注意：这四类不是碳滑板自身状态——碳滑板自身状态见 CARBON_STRIP_ALARM_TYPES。
 */
export const CATENARY_ALARM_TYPES = ['压力超限', '导高超限', '燃弧超限', '拉出值超限']

/**
 * 碳滑板自身告警（3.0 新增）：厚度磨耗、偏磨、视觉检出的表面缺陷。
 * 数据来源：厚度测量 + 磨耗预测（RUL）→ 磨耗到限预警 / 偏磨超限；
 *          回库视觉检测（YOLO 实例分割）→ 裂纹检出 / 电弧烧蚀。
 */
export const CARBON_STRIP_ALARM_TYPES = ['磨耗到限预警', '偏磨超限', '裂纹检出', '电弧烧蚀']

/** 受电弓部件告警（弓网 + 碳滑板）：参与健康度扣减与超限统计 */
export const PANTOGRAPH_ALARM_TYPES = [...CATENARY_ALARM_TYPES, ...CARBON_STRIP_ALARM_TYPES]

/**
 * 环境因素引起的告警：温度/湿度/气囊压力通道，越限不代表碳滑板故障。
 * 与后端 ENV_WARNING_CONTENTS 保持一致（后端另将高压/低压报警计入成因说明，
 * 但同样属于传感器通道，不在受电弓详情页展示）。
 */
export const ENV_ALARM_TYPES = [
  '高温预警',
  '低温预警',
  '高湿预警',
  '高压报警',
  '低压报警',
]

/** 是否为受电弓部件告警（用于页面过滤） */
export function isPantographAlarm(content) {
  return PANTOGRAPH_ALARM_TYPES.includes(content)
}

/** 从列表中筛出受电弓部件告警 */
export function filterPantographAlarms(list) {
  return (Array.isArray(list) ? list : []).filter(item => isPantographAlarm(item.content))
}

/** 各类告警在列表中的计数（用于超限卡片） */
export function countByContent(list) {
  const counts = {}
  ;(Array.isArray(list) ? list : []).forEach(item => {
    counts[item.content] = (counts[item.content] || 0) + 1
  })
  return counts
}

/* ---------------- 碳滑板健康度（与后端 health-index.js 同口径） ----------------
 *
 * 修复背景：原实现仅在本地按"当天全部告警条数"扣分，且后端 /api/stats/summary 只统计
 * 当天的部件告警（演示数据非当天 → 恒返回 100），两侧口径还不一致，导致健康度长期不变。
 *
 * 现口径（与后端 health-index.js 完全一致）：
 *   · 统计窗口：滚动 windowDays 天（默认 30）
 *   · 计入范围：仅受电弓部件告警（ENV_ALARM_TYPES 一律不扣分）
 *   · 扣分：按类型加权求和 × DECAY_FACTOR，分值 = clamp(100 − 扣分, 0, 100) 取整
 *   · 分级沿用论文表12 的 85 / 70 / 55 边界
 */

/** 告警类型权重（与后端 ALARM_WEIGHTS 一致，越直接反映碳滑板劣化权重越高） */
export const HEALTH_ALARM_WEIGHTS = {
  压力超限: 10,
  导高超限: 8,
  燃弧超限: 5,
  拉出值超限: 3,
  // 碳滑板自身告警：直接反映滑板劣化，权重高于弓网类
  磨耗到限预警: 12,
  偏磨超限: 8,
  裂纹检出: 10,
  电弧烧蚀: 6,
}

export const HEALTH_DEFAULT_WEIGHT = 3
export const HEALTH_DECAY_FACTOR = 0.5
export const HEALTH_WINDOW_DAYS = 30

/** 检修建议分级边界（论文表12：85 / 70 / 55） */
export function healthGrade(score) {
  if (score >= 85) return '正常'
  if (score >= 70) return '关注'
  if (score >= 55) return '计划检修'
  return '立即检修'
}

export function healthColor(score) {
  if (score >= 80) return '#00d68f'
  if (score >= 50) return '#ffaa00'
  return '#ff3d71'
}

/**
 * 计算碳滑板健康度（与后端 health-index.computeHealth 同口径）
 * @param {Array} list 告警列表（含 content / time）
 * @param {{windowDays?:number, now?:number}} [opts]
 */
export function computeHealthIndex(list, opts = {}) {
  const windowDays = opts.windowDays !== undefined ? Number(opts.windowDays) : HEALTH_WINDOW_DAYS
  const now = opts.now !== undefined ? Number(opts.now) : Date.now()
  const cutoff = now - windowDays * 86400000

  const byType = {}
  let weightSum = 0
  let counted = 0

  ;(Array.isArray(list) ? list : []).forEach(item => {
    if (!item || ENV_ALARM_TYPES.includes(item.content)) return   // 环境/气路类不参与扣减
    const t = item.time ? new Date(item.time).getTime() : NaN
    if (!Number.isFinite(t) || t < cutoff) return                 // 窗外样本不计
    weightSum += HEALTH_ALARM_WEIGHTS[item.content] !== undefined
      ? HEALTH_ALARM_WEIGHTS[item.content]
      : HEALTH_DEFAULT_WEIGHT
    byType[item.content] = (byType[item.content] || 0) + 1
    counted += 1
  })

  const penalty = weightSum * HEALTH_DECAY_FACTOR
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)))
  return {
    score,
    grade: healthGrade(score),
    color: healthColor(score),
    windowDays,
    windowStart: new Date(cutoff).toISOString().slice(0, 10),
    counted,
    weightSum,
    penalty: +penalty.toFixed(2),
    byType,
  }
}
