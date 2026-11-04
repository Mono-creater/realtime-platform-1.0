/**
 * adaptive-period.js —— 自适应变周期上报（论文 §4.2）
 *
 * 论文原文：
 *   "为进一步兼顾带宽与告警时效，本文提出自适应变周期上报[19]：正常工况采用长周期
 *    Pn（如 10 s）以节省带宽，当 EWMA 趋势检测（2.4 节）预判到缓变趋势时切换至
 *    短周期 Pa（如 1 s）以快速确认。设异常时间占比为 μ，平均带宽
 *     （10）B = 31·[(1−μ)/Pn + μ/Pa]。
 *    以 Pn = 10 s、Pa = 1 s 为例，异常率 5% 时平均带宽 0.388 MB/d、告警时延约 1.5 s
 *    （与固定 1 s 周期相当），较固定 1 s 周期（2.678 MB/d）节省带宽 85.5%；
 *    异常率越低节省越显著（1% 时节省 89.1%）。"
 *
 * 本模块实现：
 *   1) 状态机：NORMAL（长周期 Pn） ⇄ SUSPECT（短周期 Pa，EWMA 趋势预判触发）；
 *   2) 触发条件：EWMA 趋势检测的 roc 达到 warning 阈值的指定比例（预判，尚未越限）；
 *   3) 回退条件：趋势回落（连续 m 次未达预判比例）后经驻留时间回退至 Pn；
 *   4) 带宽与节省核算：式(10) 及相对固定短/长周期的节省率。
 *
 * 参考依据：Åström & Bernhardsson (2002) 的 Lebesgue 采样思想 —— 按"状态变化"
 * 而非"固定时间"决定上报时刻，在保持事件响应性的同时降低平均上报量。
 *
 * 无第三方依赖。
 */

'use strict';

/** 事务字节数（论文 §4.2：FC03 请求 12 B + 响应 19 B = 31 B；异常周期间追读子包再增 31 B） */
const TX_BYTES_NORMAL = 31;
const TX_BYTES_ANOMALY = 62;

/**
 * 式(10)：自适应变周期的平均日流量（MB/d，SI 制 1 MB = 10⁶ B，论文 §4.2）
 * B = 31·[(1−μ)/Pn + μ/Pa]  （式中 B 为字节/秒量纲，此处换算为 MB/d）
 *
 * @param {number} lambda 异常时间占比 μ ∈ [0,1]
 * @param {number} pnSec  正常长周期 Pn（s）
 * @param {number} paSec  异常短周期 Pa（s）
 * @param {number} [txBytes=31] 单次事务字节数
 * @returns {number} MB/d
 */
function adaptiveBandwidth(lambda, pnSec, paSec, txBytes = TX_BYTES_NORMAL) {
    const l = Math.min(1, Math.max(0, lambda));
    const bytesPerSec = txBytes * ((1 - l) / pnSec + l / paSec);
    return bytesPerSec * 86400 / 1e6;
}

/** 固定周期的日流量（MB/d，SI 制） */
function fixedBandwidth(pSec, txBytes = TX_BYTES_NORMAL) {
    return txBytes * (1 / pSec) * 86400 / 1e6;
}

/**
 * 相对固定周期的节省率
 * @returns {number} ∈ [0,1]
 */
function savingRatio(lambda, pnSec, paSec, fixedPSec, txBytes = TX_BYTES_NORMAL) {
    const base = fixedBandwidth(fixedPSec, txBytes);
    const cur = adaptiveBandwidth(lambda, pnSec, paSec, txBytes);
    return base > 0 ? Math.max(0, 1 - cur / base) : 0;
}

/**
 * 自适应变周期控制器
 *
 * 状态机：
 *   NORMAL  --(roc ≥ preemptRatio·rw 连续 preemptN 次)-->  SUSPECT
 *   SUSPECT --(连续 backN 次未达预判条件)-------------->  NORMAL
 */
class AdaptivePeriodController {
    /**
     * @param {object} opts
     * @param {number} [opts.pnSec=10]       正常长周期 Pn（s）
     * @param {number} [opts.paSec=1]        异常短周期 Pa（s）
     * @param {number} [opts.preemptRatio=0.6] 预判比例：roc 达到 rw 的该比例即预判
     * @param {number} [opts.preemptN=2]     预判需连续满足的次数
     * @param {number} [opts.backN=10]       回退需连续不满足的次数（滞回，防抖）
     */
    constructor(opts = {}) {
        this.cfg = Object.assign({
            pnSec: 10, paSec: 1,
            preemptRatio: 0.6, preemptN: 2, backN: 10,
        }, opts);
        this.state = 'NORMAL';
        this._hot = 0;
        this._cold = 0;
        /** 切换日志（审计） */
        this.log = [];
        this.switches = 0;
    }

    /** 当前周期（s） */
    currentPeriod() { return this.state === 'NORMAL' ? this.cfg.pnSec : this.cfg.paSec; }

    /**
     * 按一次 EWMA 趋势检测结果推进状态机
     * @param {?number} roc       本通道变化率（℃·min⁻¹ 等，null 表示窗口未满）
     * @param {number}  rwWarning 变化率 warning 阈值
     * @param {number}  t         时刻（ms，用于日志）
     * @returns {{state:string, periodSec:number, switched:boolean, reason:string}}
     */
    update(roc, rwWarning, t) {
        const preempt = rwWarning * this.cfg.preemptRatio;
        const hit = roc !== null && roc !== undefined && roc >= preempt;
        let switched = false, reason = '';

        if (this.state === 'NORMAL') {
            this._hot = hit ? this._hot + 1 : 0;
            this._cold = 0;
            if (this._hot >= this.cfg.preemptN) {
                this.state = 'SUSPECT';
                this.switches += 1;
                switched = true;
                reason = `EWMA 趋势预判：roc=${Number(roc).toFixed(3)} ≥ ${(this.cfg.preemptRatio * 100).toFixed(0)}%·rw（${preempt.toFixed(2)}），周期 ${this.cfg.pnSec}s → ${this.cfg.paSec}s`;
            }
        } else {
            this._cold = hit ? 0 : this._cold + 1;
            this._hot = 0;
            if (this._cold >= this.cfg.backN) {
                this.state = 'NORMAL';
                this.switches += 1;
                switched = true;
                reason = `趋势回落（连续 ${this.cfg.backN} 次未达预判条件），周期 ${this.cfg.paSec}s → ${this.cfg.pnSec}s`;
            }
        }
        if (switched) this.log.push({ t, state: this.state, reason });
        return { state: this.state, periodSec: this.currentPeriod(), switched, reason };
    }

    /** 当前配置下的带宽核算表（供前端与论文复算对照） */
    bandwidthTable(lambdas = [0.01, 0.05, 0.1, 0.5, 1.0]) {
        const { pnSec, paSec } = this.cfg;
        return {
            pnSec, paSec,
            rows: lambdas.map((l) => ({
                lambda: l,
                adaptiveMBperDay: +adaptiveBandwidth(l, pnSec, paSec).toFixed(3),
                fixedPnMBperDay: +fixedBandwidth(pnSec).toFixed(3),
                fixedPaMBperDay: +fixedBandwidth(paSec).toFixed(3),
                savingVsPa: +(savingRatio(l, pnSec, paSec, paSec) * 100).toFixed(1),
            })),
        };
    }
}

module.exports = {
    TX_BYTES_NORMAL, TX_BYTES_ANOMALY,
    adaptiveBandwidth, fixedBandwidth, savingRatio,
    AdaptivePeriodController,
};
