/**
 * health-index.js —— 碳滑板健康度（代理指标）的【单一实现来源】
 *
 * 背景与修复动机
 * --------------
 * 原实现（server.js `/api/stats/summary`）存在三处缺陷，导致前端"碳滑板健康度"恒为 100%：
 *   1) 仅统计【当天】的告警（`new Date().toISOString().slice(0,10)`）。
 *      演示数据日期为 2026-09-30 ~ 10-04，与"今天"不同日 → 计数恒为 0 → 硬编码返回 100。
 *   2) 扣分粒度失真：`health = 100 − 告警条数 × 0.5`，单条告警扣 0.5 分后
 *      `Math.round(99.5) = 100`，等于"报警了也不掉分"。
 *   3) 口径与项目约定不一致：`alarm-types.js` 明确"环境/传感器通道告警（含高压/低压报警）
 *      不参与碳滑板健康度扣减"，但后端 `ENV_WARNING_CONTENTS` 只列了 3 项（高温/低温/高湿），
 *      高压/低压报警仍被计入；且前端另有一套按类型加权的公式，两端口径漂移。
 *
 * 本模块的统一口径
 * ----------------
 *   · 统计窗口：滚动 windowDays 天（默认 30 天，可用环境变量 HEALTH_WINDOW_DAYS 覆盖）
 *   · 计入范围：仅"受电弓部件告警"（压力超限 / 导高超限 / 燃弧超限 / 拉出值超限）
 *   · 扣分规则：按告警类型加权求和后乘以衰减系数（与前端既有权重字典一致）
 *   · 分值区间：[0, 100]，取整；分级沿用论文表15 的 85 / 70 / 55 边界
 *
 * 说明：健康指数为多指标加权的**代理指标**（在缺少滑板厚度直接测量时使用），
 *       权重与窗口为工程初值，投运前应按线路实测数据标定。
 * 无第三方依赖。
 */

'use strict';

/** 环境/传感器通道告警：反映线路环境与气路状态，不代表碳滑板自身故障，不参与扣减 */
const ENV_ALARM_TYPES = ['高温预警', '低温预警', '高湿预警', '高压报警', '低压报警'];

/** 受电弓部件告警：碳滑板自身状态异常，参与健康度扣减 */
const PANTOGRAPH_ALARM_TYPES = [
    '压力超限', '导高超限', '燃弧超限', '拉出值超限',
    // 3.0：碳滑板自身告警
    '磨耗到限预警', '偏磨超限', '裂纹检出', '电弧烧蚀',
];

/** 告警类型权重（分值）：越直接反映碳滑板劣化，权重越高 */
const ALARM_WEIGHTS = {
    压力超限: 10,
    导高超限: 8,
    燃弧超限: 5,
    拉出值超限: 3,
    磨耗到限预警: 12,
    偏磨超限: 8,
    裂纹检出: 10,
    电弧烧蚀: 6,
};

/** 未登记类型的兜底权重 */
const DEFAULT_WEIGHT = 3;

/** 衰减系数：扣分 = 加权告警数 × 该系数 */
const DECAY_FACTOR = 0.5;

/** 默认统计窗口（天） */
const DEFAULT_WINDOW_DAYS = 30;

/** 检修建议分级（论文表15 注：边界 85 / 70 / 55） */
const GRADE = [
    { min: 85, grade: '正常' },
    { min: 70, grade: '关注' },
    { min: 55, grade: '计划检修' },
    { min: 0, grade: '立即检修' },
];

/** 该告警类型是否参与碳滑板健康度扣减 */
function isHealthRelated(content) {
    return !ENV_ALARM_TYPES.includes(content);
}

function gradeOf(score) {
    return (GRADE.find((g) => score >= g.min) || GRADE[GRADE.length - 1]).grade;
}

/** 前端配色分档（与 MonitorGlobal.vue 的 getHealthColor 保持一致） */
function healthColor(score) {
    if (score >= 80) return '#00d68f';
    if (score >= 50) return '#ffaa00';
    return '#ff3d71';
}

/**
 * 计算碳滑板健康度
 *
 * @param {Array<{content:string, time:(string|Date|number)}>} list 告警列表
 * @param {object} [opts]
 * @param {number} [opts.windowDays] 统计窗口（天），默认 30
 * @param {number} [opts.now]        基准时刻（ms），便于测试注入
 * @returns {{
 *   score:number, grade:string, color:string,
 *   windowDays:number, windowStart:string,
 *   counted:number, weightSum:number, penalty:number,
 *   byType:Object<string,number>, excludedEnv:number,
 *   cutoffMs:number, note:string
 * }}
 */
function computeHealth(list, opts = {}) {
    const windowDays = opts.windowDays !== undefined ? Number(opts.windowDays) : DEFAULT_WINDOW_DAYS;
    const now = opts.now !== undefined ? Number(opts.now) : Date.now();
    const cutoff = now - windowDays * 86400000;

    const all = Array.isArray(list) ? list : [];
    const byType = {};
    let weightSum = 0;
    let counted = 0;
    let excludedEnv = 0;

    for (const w of all) {
        if (!w || !isHealthRelated(w.content)) { excludedEnv += 1; continue; }
        const t = w.time !== undefined && w.time !== null ? new Date(w.time).getTime() : NaN;
        if (!Number.isFinite(t) || t < cutoff) continue;      // 窗外样本不计
        weightSum += ALARM_WEIGHTS[w.content] !== undefined ? ALARM_WEIGHTS[w.content] : DEFAULT_WEIGHT;
        byType[w.content] = (byType[w.content] || 0) + 1;
        counted += 1;
    }

    const penalty = weightSum * DECAY_FACTOR;
    const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));

    return {
        score,
        grade: gradeOf(score),
        color: healthColor(score),
        windowDays,
        windowStart: new Date(cutoff).toISOString().slice(0, 10),
        counted,
        weightSum,
        penalty: +penalty.toFixed(2),
        byType,
        excludedEnv,
        cutoffMs: cutoff,
        note: '代理指标：仅统计窗口内的受电弓部件告警（压力/导高/燃弧/拉出值）；环境与气路类告警不参与扣减',
    };
}

module.exports = {
    ENV_ALARM_TYPES,
    PANTOGRAPH_ALARM_TYPES,
    ALARM_WEIGHTS,
    DEFAULT_WEIGHT,
    DECAY_FACTOR,
    DEFAULT_WINDOW_DAYS,
    GRADE,
    isHealthRelated,
    gradeOf,
    healthColor,
    computeHealth,
};
