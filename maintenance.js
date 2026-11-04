/**
 * maintenance.js —— 运维闭环（论文 §3.1 / §3.2，式(7)(8)(9)）
 *
 * 功能：
 *  1) 工单状态机（表5）：新建 → 指派 → 处理中 → 完成 → 复核（含取消），全程审计轨迹；
 *  2) 健康指数（式7）与检修建议分级（85/70/55 四档）；
 *  3) 剩余寿命预测（式8）接入，健康评估由"当前状态打分"升级为"状态＋趋势＋剩余寿命"；
 *  4) 运维 KPI：MTTR（式9）、可用率、数据完整率、丢包率。
 *
 * ⚠ 本次升级的两处口径修正：
 *  (a) 取消动作的允许起始状态：旧实现仅允许 new；
 *      论文表5 明确允许 new / assigned / in_progress（现场常见"误报建单—已派工—复核确认误报"路径），
 *      且取消须填写原因。
 *  (b) 健康指数扣分口径：旧实现用【百分比偏离】口径
 *        pF = min(25, 0.5·|F̄−Ft|/Ft×100)、pσ = min(25, 0.8·σF/Ft×100)，
 *      论文式(7) 为【绝对量】口径 pF = min(25, 0.5·|F̄−Ft|)、pσ = min(25, 0.8·σF)。
 *      两者仅在 Ft = 100 N 时数值巧合相等；本实现按论文口径统一，
 *      使平台输出与论文表15 的"扣分明细"逐项一致（且不再隐含绑定 Ft=100 的假设）。
 *
 * 说明：健康指数为多指标加权的**代理指标**（在缺少滑板厚度直接测量时使用），
 *       权重与扣分上限为工程初值，投运前应按线路实测数据标定（论文 §4.1）。
 * 无第三方依赖。
 */

'use strict';

const std = require('./standards');
const { RULPredictor } = require('./rul-predictor');

/** 检修建议分级（论文表15 注：分级边界 85、70、55） */
const GRADE = [
    { min: 85, grade: '正常', advice: '按周期巡检，保持常规监测' },
    { min: 70, grade: '关注', advice: '加密监测频次，纳入下次天窗复检' },
    { min: 55, grade: '计划检修', advice: '安排计划检修工单，检查气路与接触压力' },
    { min: 0, grade: '立即检修', advice: '触发紧急工单，停运检查碳滑板与受电弓状态' },
];

/** 表5：工单状态机迁移关系 */
const TRANSITIONS = {
    assign:   { from: ['new'], target: 'assigned',    record: '处理人' },
    start:    { from: ['assigned'], target: 'in_progress', record: '开始时间' },
    complete: { from: ['in_progress'], target: 'completed', record: '完成时间、备注' },
    verify:   { from: ['completed'], target: 'verified', record: '复核时间、备注' },
    cancel:   { from: ['new', 'assigned', 'in_progress'], target: 'cancelled', record: '取消原因、备注' },
};

class MaintenanceService {
    constructor(opts = {}) {
        this.seq = 0;
        this.orders = [];
        this.cfg = Object.assign({
            forcePenaltyCap: 25,     // 接触力偏离扣分上限
            wavePenaltyCap: 25,      // 波动扣分上限
            tempPenaltyCap: 25,      // 温度越限扣分上限
            alarmPenaltyCap: 25,     // 告警频次扣分上限
            /** 式(7) 系数（论文：0.5 / 0.8 / 2.5 / 2.5），投运后按现场标定 */
            kForce: 0.5,
            kWave: 0.8,
            kTemp: 2.5,
            kAlarm: 2.5,
            /** 温度上限 Tlim（论文取 80 ℃） */
            tempLimit: 80,
        }, opts);
        /** RUL 预测器（式8）：按监测量分别拟合滑窗均值序列 */
        this.rul = new RULPredictor({
            fitWindowMin: opts.rulWindowMin !== undefined ? opts.rulWindowMin : 10,
            minSlope: opts.rulMinSlope !== undefined ? opts.rulMinSlope : 0.001,
            thresholds: { temperature: this.cfg.tempLimit },
        });
    }

    _id() { return 'WO' + String(++this.seq).padStart(5, '0'); }

    create({ deviceId, alarmId, level = 'warning', description = '', at }) {
        const t0 = at !== undefined ? at : Date.now();
        const o = {
            id: this._id(), deviceId, alarmId, level, description,
            status: 'new', createdAt: t0, assignee: null,
            startedAt: null, completedAt: null, verifiedAt: null, cancelledAt: null,
            remark: '', cancelReason: '', healthAtCreate: null,
            audit: [{ at: t0, action: 'create', worker: 'system', note: description }],
        };
        this.orders.push(o);
        return o;
    }

    /**
     * 状态迁移（论文表5）
     * @returns {{ok:boolean, order?:object, error?:string}}
     */
    _transition(id, action, worker, at, note) {
        const o = this.orders.find((x) => x.id === id);
        if (!o) return { ok: false, error: '工单不存在' };
        const tr = TRANSITIONS[action];
        if (!tr) return { ok: false, error: `未知动作：${action}` };
        if (!tr.from.includes(o.status)) {
            return { ok: false, error: `状态不允许：${o.status} 不能执行 ${action}（允许的起始状态：${tr.from.join(' / ')}）` };
        }
        // 取消须填写原因（论文 §3.1）
        if (action === 'cancel' && (!note || !String(note).trim())) {
            return { ok: false, error: '取消工单须填写取消原因' };
        }
        o.status = tr.target;
        const t = at !== undefined ? at : Date.now();
        if (action === 'assign') { o.assignee = worker; }
        if (action === 'start') { o.startedAt = t; }
        if (action === 'complete') { o.completedAt = t; if (note) o.remark = note; }
        if (action === 'verify') { o.verifiedAt = t; if (note) o.remark = note; }
        if (action === 'cancel') { o.cancelledAt = t; if (note) { o.cancelReason = note; o.remark = note; } }
        o.audit.push({ at: t, action, worker: worker || 'system', note: note || '' });
        return { ok: true, order: o };
    }

    assign(id, worker, at) { return this._transition(id, 'assign', worker, at, ''); }
    start(id, worker, at) { return this._transition(id, 'start', worker, at, ''); }
    complete(id, worker, at, note) { return this._transition(id, 'complete', worker, at, note); }
    verify(id, worker, at, note) { return this._transition(id, 'verify', worker, at, note); }
    cancel(id, worker, at, note) { return this._transition(id, 'cancel', worker, at, note); }

    list(filter = {}) { return this.orders.filter((o) => !filter.status || o.status === filter.status); }
    auditTrail(id) { const o = this.orders.find((x) => x.id === id); return o ? o.audit : []; }
    /** 式(9)：MTTR = 修复总时长 / 已完成工单数（min） */
    mttr() { return std.mttr(this.orders); }

    /**
     * 健康指数 H = 100 − (pF + pσ + pT + pA)（式7）
     *
     *   pF = min(25, 0.5·|F̄ − Ft|)              接触力偏离（绝对量，N）
     *   pσ = min(25, 0.8·σF)                      接触力波动（绝对量，N）
     *   pT = min(25, 2.5·max(0, Tmax − Tlim))     温度越限程度（℃），Tlim = 80
     *   pA = min(25, 2.5·N24h)                    24 h 告警频次（条）
     *
     * @param {{forceMean:number, forceTarget?:number, forceStd?:number,
     *          tempMax?:number, tempLimit?:number, alarmCount24h?:number}} m
     */
    healthIndex(m) {
        const c = this.cfg;
        const Ft = m.forceTarget !== undefined ? m.forceTarget : 100;

        const pForce = Math.min(c.forcePenaltyCap, c.kForce * Math.abs(m.forceMean - Ft));
        const pWave = Math.min(c.wavePenaltyCap, c.kWave * (m.forceStd !== undefined ? m.forceStd : 0));
        const tLim = m.tempLimit !== undefined ? m.tempLimit : c.tempLimit;
        const tOver = m.tempMax !== undefined ? Math.max(0, m.tempMax - tLim) : 0;
        const pTemp = Math.min(c.tempPenaltyCap, c.kTemp * tOver);
        const alarms = m.alarmCount24h || 0;
        const pAlarm = Math.min(c.alarmPenaltyCap, c.kAlarm * alarms);

        const raw = 100 - (pForce + pWave + pTemp + pAlarm);
        const score = Math.max(0, Math.round(raw));      // 表15 注：四舍五入取整，理论下限 0
        const g = GRADE.find((x) => score >= x.min);
        return {
            score, grade: g.grade, advice: g.advice,
            penalties: {
                force: +pForce.toFixed(1), wave: +pWave.toFixed(1),
                temp: +pTemp.toFixed(1), alarm: +pAlarm.toFixed(1),
            },
            note: '代理指标：无滑板厚度直接测量时使用，投运前应按线路数据标定',
        };
    }

    /** 由告警自动生成工单（分级→工单等级映射） */
    createFromAlarm(alarm, deviceId, at) {
        const levelMap = { warning: 'warning', major: 'major', critical: 'critical' };
        return this.create({
            deviceId, alarmId: alarm.id, level: levelMap[alarm.level] || 'warning',
            description: `[${alarm.level}] ${alarm.message}`, at,
        });
    }

    /* ---------------- 剩余寿命预测（式8，论文 §3.2） ---------------- */

    /**
     * 推入一个滑窗均值采样并更新 RUL 估计
     * 论文：窄带链路仅上传滑窗均值，故最小二乘拟合须在滑窗均值序列上进行。
     */
    pushSample(sig, tMs, x) { return this.rul.push(sig, tMs, x); }

    /** 当前 RUL 估计 */
    rulEstimate(sig) { return this.rul.estimate(sig, Date.now() / 60000); }

    /** 综合评估：健康指数 + 退化趋势 + 剩余寿命（论文 §3.2"状态＋趋势＋剩余寿命"） */
    comprehensive(m) {
        const health = this.healthIndex(m);
        const rul = this.rulEstimate('temperature');
        return {
            health,
            rul,
            summary: rul && rul.rul !== null
                ? `健康指数 ${health.score}（${health.grade}）；温度退化速率 β=${rul.beta} ℃/min，预计 ${rul.rul} min 达到告警阈值`
                : `健康指数 ${health.score}（${health.grade}）；退化趋势未达可辨识下限，暂不外推 RUL`,
            note: 'RUL 为线性退化外推的工程估计，投运前须按现场实测标定',
        };
    }
}

module.exports = { MaintenanceService, GRADE, TRANSITIONS };
