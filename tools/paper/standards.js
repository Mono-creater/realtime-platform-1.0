/**
 * standards.js —— 行业标准与指标公式模块（可选依赖，纯函数）
 *
 * 依据：
 * 1) 目标平均接触力随速度的经验式（EN 50367 / TB/T 3271 给出的形式）：
 *      交流制式：Fm(v) = 0.000 97·v² + 70      （N，v 为 km/h）
 *      直流制式：Fm(v) = 0.001 55·v² + 70
 *    说明：系数为公开文献与标准中引用的经验式形式，工程实施前应按项目采用的标准版本
 *          （EN 50367 / TB/T 3271）复核，并可通过配置覆盖（见 FORCE_LAW_OVERRIDE）。
 * 2) 动态接触力一致性判据（同源标准）：标准差 σ ≤ 0.3·Fm，且
 *      Fmax ≤ Fm + 3σ，Fmin ≥ Fm − 3σ（限值均可配置）。
 * 3) 工业控制系统安全要求（GB/T 30976 系列）提示：写操作白名单、最小权限、
 *      操作审计与速率限制；本模块只提供判据与配置，具体策略在网关/服务端实施。
 *
 * 本模块不引入任何第三方依赖，便于在 PLC 模拟器、服务端与前端构建期复用。
 */

'use strict';

const FORCE_LAW = {
    AC: { a: 0.00097, b: 70 },   // N, v: km/h
    DC: { a: 0.00155, b: 70 },
};

const STANDARD_REF = {
    forceLaw: 'EN 50367 / TB/T 3271 目标平均接触力经验式（系数需按采用版本复核）',
    dynamic: 'σ ≤ 0.3·Fm；Fmax ≤ Fm + 3σ；Fmin ≥ Fm − 3σ（可配置）',
    security: 'GB/T 30976 系列 工业控制系统信息安全：最小权限、写白名单、审计、速率限制',
};

/** 目标平均接触力：Fm(v) = a·v² + b，并按上下限截断 */
function targetMeanContactForce(v, opts = {}) {
    const system = (opts.system || 'AC').toUpperCase();
    const law = (opts.law || FORCE_LAW)[system] || FORCE_LAW.AC;
    const speed = Math.max(0, Number(v) || 0);
    const raw = law.a * speed * speed + law.b;
    const lo = opts.min !== undefined ? opts.min : 70;
    const hi = opts.hi !== undefined ? opts.hi : 250;
    return { value: Math.min(hi, Math.max(lo, raw)), raw, system, speed, law };
}

/** 动态限值：{ sigmaMax, fMax, fMin } */
function dynamicLimits(Fm, opts = {}) {
    const sigmaRatio = opts.sigmaRatio !== undefined ? opts.sigmaRatio : 0.3;
    const k = opts.sigmaK !== undefined ? opts.sigmaK : 3;
    const sigmaMax = sigmaRatio * Fm;
    return { sigmaMax, fMax: Fm + k * sigmaMax, fMin: Fm - k * sigmaMax };
}

/**
 * 接触力一致性评价（用于在线质量判定与验收）
 * @param {{v:number, mean:number, std:number, system?:string, opts?:object}} s
 * @returns {{ok:boolean, target:object, limits:object, violations:string[]}}
 */
function evaluateContactForce(s) {
    const target = targetMeanContactForce(s.v, Object.assign({ system: s.system }, s.opts));
    const limits = dynamicLimits(target.value, s.opts);
    const violations = [];
    if (s.mean > limits.fMax) violations.push(`平均接触力 ${s.mean.toFixed(1)} N 超过上限 ${limits.fMax.toFixed(1)} N`);
    if (s.mean < limits.fMin) violations.push(`平均接触力 ${s.mean.toFixed(1)} N 低于下限 ${limits.fMin.toFixed(1)} N`);
    if (s.std !== undefined && s.std > limits.sigmaMax) {
        violations.push(`接触力标准差 ${s.std.toFixed(2)} N 超过限值 ${limits.sigmaMax.toFixed(2)} N`);
    }
    return { ok: violations.length === 0, target, limits, violations };
}

/**
 * 告警配置：阈值（沿用现场既有取值）+ 分级 + 变化率判据（可配置默认值）
 * 说明：分级与变化率阈值为工程默认值，用于缩短缓变异常的发现时间；
 *       正式投运前应按运营单位检修规程与线路实测数据标定。
 */
const ALARM_DEFAULTS = {
    temperature: {
        warningHigh: 80, majorHigh: 90, criticalHigh: 100,
        warningLow: -10, majorLow: -20,
        rocPerMin: { warning: 2.0, major: 5.0 },     // ℃/min
        unit: '℃',
    },
    pressure: {
        warningHigh: 1000, majorHigh: 1100, criticalHigh: 1200,
        warningLow: 100, majorLow: 80,
        rocPerMin: { warning: 80, major: 200 },      // kPa/min
        unit: 'kPa',
    },
    humidity: {
        warningHigh: 85, majorHigh: 92, criticalHigh: 97,
        rocPerMin: { warning: 5.0, major: 12.0 },    // %RH/min
        unit: '%RH',
    },
};

const SEVERITY_ORDER = { normal: 0, warning: 1, major: 2, critical: 3 };
function maxSeverity(a, b) { return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b; }

/* ---------------- KPI 公式 ---------------- */

/** 可用率 = 1 − 停机时长/统计时长（均为 ms） */
function availability(downMs, totalMs) {
    if (totalMs <= 0) return 0;
    return Math.max(0, 1 - downMs / totalMs);
}

/** 数据完整率 = 有效样本/应有样本 */
function dataCompleteness(goodSamples, expectedSamples) {
    if (expectedSamples <= 0) return 0;
    return Math.min(1, goodSamples / expectedSamples);
}

/** 丢包率 = 序号缺口数/应到包数 */
function packetLossRate(gapCount, expectedPackets) {
    if (expectedPackets <= 0) return 0;
    return Math.min(1, gapCount / expectedPackets);
}

/** 时延统计：{n, mean, p50, p95, max}（单位 ms） */
function latencyStats(samples) {
    if (!samples || !samples.length) return { n: 0, mean: null, p50: null, p95: null, max: null };
    const a = samples.slice().sort((x, y) => x - y);
    const n = a.length;
    const q = (p) => a[Math.min(n - 1, Math.floor(p * n))];
    return {
        n,
        mean: Math.round(a.reduce((s, v) => s + v, 0) / n),
        p50: q(0.5), p95: q(0.95), max: a[n - 1],
    };
}

/** MTTR（平均修复时间，分钟）= 修复总时长/工单数 */
function mttr(orders) {
    const closed = (orders || []).filter((o) => o && o.completedAt != null && o.createdAt != null);
    if (!closed.length) return null;
    const total = closed.reduce((s, o) => s + (o.completedAt - o.createdAt), 0);
    return Math.round(total / closed.length / 60000 * 10) / 10;
}

module.exports = {
    STANDARD_REF, FORCE_LAW, ALARM_DEFAULTS, SEVERITY_ORDER,
    targetMeanContactForce, dynamicLimits, evaluateContactForce,
    maxSeverity, availability, dataCompleteness, packetLossRate, latencyStats, mttr,
};
