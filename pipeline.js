/**
 * pipeline.js —— v2 判据/运维能力的【唯一运行实例】
 *
 * 背景（1.0 遗留缺陷）：
 *   alarm-engine / link-monitor / maintenance / adaptive-period 原本只被
 *   upgrade-routes.js 内部实例化，仅由 POST /api/v2/ingest 驱动。
 *   平台真正的数据来自 server.js 的 PLC 采集循环，二者从未相连 ——
 *   结果 /api/v2/link 恒 packets=0、/api/v2/alarms 恒空、工单永远为空，
 *   论文 §2.4 的 EWMA 判据在运行态不生效。
 *
 * 本模块把四个引擎收拢为一个可注入的单例：
 *   · server.js 采集链路 → pipeline.ingest()（每条采样）
 *   · upgrade-routes.js  → 读同一实例（REST 反映实时状态）
 *   · 运行态序列化 → runtime-store.js（重启后工单/告警编号延续）
 *
 * 处理链（论文 §2.3）：3 点中值 → EWMA → 阈值通道‖变化率通道 → 取高 → 连续 n 点确认 → 抑制去重
 * 链路（论文 §2.1/§2.2）：序号连续性 → 丢包率/Wilson → 质量码 → 指数退避
 * 运维（论文 §3）：major/critical 告警自动建单（同信号同等级 10 min 冷却）+ RUL 滑窗拟合
 *
 * 无第三方依赖。
 */

'use strict';

const { AlarmEngine } = require('./alarm-engine');
const { LinkMonitor } = require('./link-monitor');
const { MaintenanceService } = require('./maintenance');
const { AdaptivePeriodController } = require('./adaptive-period');

/** 检测器内部短名 → 配置键名 */
const SIG_NAME = { temp: 'temperature', press: 'pressure', humid: 'humidity' };

/** 告警信号 → 中文标签（前端展示用） */
const SIGNAL_LABEL = { temperature: '温度', pressure: '压力', humidity: '湿度' };

class Pipeline {
    constructor(opts = {}) {
        this.alarms = new AlarmEngine(opts.alarm || {});
        this.link = new LinkMonitor(opts.link || {});
        this.maint = new MaintenanceService(Object.assign(
            { rulWindowMin: opts.rulWindowMin !== undefined ? opts.rulWindowMin : 10 },
            opts.maintenance || {}
        ));
        this.adaptive = new AdaptivePeriodController(opts.adaptive || {});

        /** 告警自动建单开关（论文 §3.1 运维闭环；关闭后仅保留告警） */
        this.autoCreateOrder = opts.autoCreateOrder !== false;
        /** 同信号同等级的建单冷却（避免 2 s 级采样把工单表刷爆） */
        this.orderCooldownMs = opts.orderCooldownMs !== undefined ? opts.orderCooldownMs : 10 * 60 * 1000;

        this.startedAt = Date.now();
        this.lastSample = null;
        this.ingested = 0;
        this.ordersCreated = 0;

        /** @type {Map<string, number>} signal|level -> 上次建单时刻 */
        this._orderAt = new Map();
        /** 变更回调（由 server.js 注入：序列化落盘） */
        this.onChange = null;
    }

    /** 供外部（REST）在状态变更后触发持久化 */
    touch() {
        if (typeof this.onChange === 'function') {
            try { this.onChange(); } catch (e) { console.warn('⚠️ pipeline.onChange 失败:', e.message); }
        }
    }

    /**
     * 推入一条采样（PLC 主包 / 旧固件回退 / 模拟器共用）
     *
     * @param {{t?:number, temperature?:number, pressure?:number, humidity?:number,
     *          seq?:?number, deviceId?:string, truthOnsetMs?:number}} sample
     * @returns {{alarms:Array, orders:Array, link:object, adaptive:object, rul:?object}}
     */
    ingest(sample = {}) {
        const t = sample.t !== undefined && Number.isFinite(Number(sample.t)) ? Number(sample.t) : Date.now();
        const clean = { t, truthOnsetMs: sample.truthOnsetMs };
        let hasSignal = false;
        for (const k of ['temperature', 'pressure', 'humidity']) {
            if (sample[k] !== undefined && sample[k] !== null && Number.isFinite(Number(sample[k]))) {
                clean[k] = Number(sample[k]);
                hasSignal = true;
            }
        }
        if (!hasSignal) return { alarms: [], orders: [], link: this.link.stats(t), adaptive: null, rul: null };

        this.ingested += 1;
        this.lastSample = clean;

        // 1) 链路：序号连续性（seq=0/null 视为旧固件帧，排除在统计外）
        const linkStats = this.link.onPacket({
            t,
            seq: sample.seq !== undefined && sample.seq !== null ? Number(sample.seq) : null,
        });

        // 2) 告警：EWMA 趋势检测（阈值通道 + 变化率通道取高）
        const newAlarms = this.alarms.push(clean);

        // 3) 自适应变周期：用温度通道的变化率预判（论文 §4.2）
        const rwT = this.alarms.cfg.thresholds.temperature.rocPerMin.warning;
        const adaptive = this.adaptive.update(this._tempRoc(t), rwT, t);

        // 4) RUL：滑窗均值序列最小二乘（论文 §3.2 式8）
        const rul = clean.temperature !== undefined
            ? this.maint.pushSample('temperature', t, clean.temperature)
            : null;

        // 5) 运维闭环：major/critical 自动建单（同信号同等级冷却）
        const orders = [];
        if (this.autoCreateOrder) {
            for (const a of newAlarms) {
                if (a.level !== 'major' && a.level !== 'critical') continue;
                const key = `${a.signal}|${a.level}`;
                const last = this._orderAt.get(key) || 0;
                if (t - last < this.orderCooldownMs) continue;
                this._orderAt.set(key, t);
                orders.push(this.maint.createFromAlarm(a, sample.deviceId || 'PLC-01', t));
                this.ordersCreated += 1;
            }
        }

        if ((newAlarms.length || orders.length) && this.onChange) this.touch();

        return { alarms: newAlarms, orders, link: linkStats, adaptive, rul };
    }

    /** 温度通道当前变化率（与 EwmaTrendDetector 内部口径一致：年龄最接近 W 的基准） */
    _tempRoc(t) {
        const det = this.alarms.detector;
        const zs = det.series('temp');
        if (!zs.length) return null;
        const base = det._baseline('temp', t);
        if (!base) return null;
        const spanMin = Math.max((t - base.t) / 60000, 1 / 60);
        return (zs[zs.length - 1].z - base.z) / spanMin;
    }

    /** 运行期标定传感器噪声 σ（论文 §4.4） */
    setSigma(sigma) {
        this.alarms.setSigma(sigma);
        this.touch();
        return this.alarms.analytics();
    }

    /** 调整自适应周期 Pn / Pa */
    setPeriods({ pnSec, paSec } = {}) {
        if (pnSec !== undefined && Number(pnSec) > 0) this.adaptive.cfg.pnSec = Number(pnSec);
        if (paSec !== undefined && Number(paSec) > 0) this.adaptive.cfg.paSec = Number(paSec);
        this.touch();
        return { state: this.adaptive.state, periodSec: this.adaptive.currentPeriod() };
    }

    /** 当前运行态快照（REST /overview 与前端轮询用） */
    snapshot(extra = {}) {
        const now = Date.now();
        const link = this.link.stats(now);
        return {
            startedAt: this.startedAt,
            uptimeSec: Math.round((now - this.startedAt) / 1000),
            ingested: this.ingested,
            lastSample: this.lastSample,
            link,
            alarms: Object.assign(this.alarms.stats(), {
                recent: this.alarms.alarms.slice(-20).reverse(),
            }),
            orders: { list: this.maint.list(), mttr: this.mttr() },
            ordersCreated: this.ordersCreated,
            adaptive: {
                state: this.adaptive.state,
                periodSec: this.adaptive.currentPeriod(),
                cfg: this.adaptive.cfg,
                switches: this.adaptive.switches,
                log: this.adaptive.log.slice(-5),
            },
            ewma: this.alarms.analytics(),
            rul: this.maint.rulEstimate('temperature'),
            sigma: this.alarms.cfg.sigma,
            autoCreateOrder: this.autoCreateOrder,
            signalLabel: SIGNAL_LABEL,
            ...extra,
        };
    }

    /** 可用率（论文 §4.5）：1 − 链路中断累计时长 / 运行时长 */
    availability(nowMs) {
        const now = nowMs || Date.now();
        const runtime = Math.max(1, now - this.startedAt);
        const s = this.link.stats(now);
        return Math.max(0, Math.min(1, 1 - (s.downMs || 0) / runtime));
    }

    /** MTTR（min），口径见 standards.mttr */
    mttr() { return this.maint.mttr(); }

    /* ---------------- 运行态序列化 ---------------- */

    serialize() {
        return {
            version: 1,
            savedAt: Date.now(),
            startedAt: this.startedAt,
            ingested: this.ingested,
            ordersCreated: this.ordersCreated,
            orders: this.maint.orders,
            orderSeq: this.maint.seq,
            alarms: this.alarms.alarms.slice(-500),
            alarmSeq: this.alarms.seq,
            suppressed: this.alarms.suppressed,
            noiseWarnings: this.alarms.noiseWarnings.slice(-20),
            sigma: this.alarms.cfg.sigma,
            downMs: this.link.stats(Date.now()).downMs,
            orderAt: Array.from(this._orderAt.entries()).slice(-50),
        };
    }

    /** 从快照恢复（容错：任何字段异常都不阻断启动） */
    restore(state) {
        if (!state || typeof state !== 'object') return false;
        try {
            if (Array.isArray(state.orders)) {
                this.maint.orders = state.orders;
                const maxId = this.maint.orders.reduce((m, o) => {
                    const n = Number(String(o.id || '').replace(/\D/g, ''));
                    return Number.isFinite(n) ? Math.max(m, n) : m;
                }, 0);
                this.maint.seq = Math.max(Number(state.orderSeq) || 0, maxId);
            }
            if (Array.isArray(state.alarms)) {
                this.alarms.alarms = state.alarms;
                const maxId = this.alarms.alarms.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0);
                this.alarms.seq = Math.max(Number(state.alarmSeq) || 0, maxId);
            }
            if (Number.isFinite(Number(state.suppressed))) this.alarms.suppressed = Number(state.suppressed);
            if (Array.isArray(state.noiseWarnings)) this.alarms.noiseWarnings = state.noiseWarnings;
            if (Number.isFinite(Number(state.sigma)) && Number(state.sigma) > 0) {
                this.alarms.setSigma(Number(state.sigma));
            }
            if (Number.isFinite(Number(state.downMs))) this.link.downMs = Number(state.downMs);
            if (Array.isArray(state.orderAt)) {
                this._orderAt = new Map(state.orderAt.filter((e) => Array.isArray(e) && e.length === 2));
            }
            this.ordersCreated = Number(state.ordersCreated) || this.maint.orders.length;
            this.ingested = Number(state.ingested) || 0;
            return true;
        } catch (e) {
            console.warn('⚠️ 运行态恢复失败，按空状态启动:', e.message);
            return false;
        }
    }
}

function createPipeline(opts = {}) { return new Pipeline(opts); }

module.exports = { Pipeline, createPipeline, SIG_NAME, SIGNAL_LABEL };
