/**
 * link-monitor.js —— 通信链路质量与写操作校验（论文 §2.1 / §2.2 / §4.3）
 *
 * 功能：
 *  1) 【回绕感知】报文序号连续性检查 → 丢包率（式(1)(2)）；
 *  2) 数据新鲜度（staleness）与三态质量码 GOOD/STALE/BAD（式(3)），供前端标注与告警抑制；
 *  3) 心跳超时判定与指数退避重连（式(4)），避免雪崩式重连；
 *  4) 丢包率的小样本置信区间（Wilson 区间，式(11)）——区分"链路正常"与"链路劣化"；
 *  5) 写操作"写入—回读"校验（write-verify），防"以为写了、实际没写"的隐性失效；
 *  6) 统计指标：应到包数/缺口数/丢包率/连续正常时长。
 *
 * ⚠ 本次升级的核心（论文 §2.1）：
 *   旧实现直接以 65 536 为模计算步长，回绕点 65 535→1 被误算为 d=2，
 *   使零丢包链路每个回绕周期（65 535 帧）凭空产生 1 个缺口；
 *   旧固件帧（序号 0）若未排除，恢复后会把 0 当作基准序号而一次性产生巨量虚假缺口。
 *   本实现按论文语义修正：
 *     · 有效序号域 [1, 65 535]，回绕路径 65 535→1，步长仍为 1；
 *     · 序号 0 为保留值（标识不支持序号的旧固件），排除在连续性统计之外，
 *       且不更新基准序号；
 *     · 回绕点特判，其余按 16 位模回绕。
 *
 * 依据：GB/T 30976 系列对工业控制系统"数据完整性、操作可审计、最小权限"的要求；
 *       Modbus 应用协议规范（无内建校验，需应用层补充序号与回读校验）；
 *       Wilson (1927) 置信区间。
 * 无第三方依赖。
 */

'use strict';

const std = require('./standards');

/** 16 位序号模 */
const SEQ_MOD = 65536;
/** 有效序号上限；0 为保留值（旧固件标识） */
const SEQ_MAX = 65535;

class LinkMonitor {
    constructor(opts = {}) {
        this.cfg = Object.assign({
            expectedIntervalMs: 1000,   // 预期报文周期
            staleMs: 3000,              // 超过该时长未收到报文 → STALE（论文取 3 s）
            badMs: 10000,               // 超过该时长 → BAD（论文取 10 s）
            heartbeatTimeoutMs: 5000,
            baseBackoffMs: 500,         // τ0 = 500 ms
            maxBackoffMs: 8000,         // τmax = 8 s
        }, opts);
        this.packets = 0; this.gaps = 0; this.expected = 0;
        this.lastSeq = null; this.lastPacketAt = null;
        this.lastGoodAt = null; this.state = 'GOOD';
        this.failures = 0; this.backoffStep = 0;
        this.writeLog = [];
        /** 链路中断累计时长（论文 §4.5 可用率的分子），ms */
        this.downMs = 0;
        /** 本次中断起始时刻（收到报文或成功连接后清零） */
        this.downSince = null;
        /** 被排除的旧固件帧计数（序号 0） */
        this.legacyFrames = 0;
        /** 回绕点跨越次数（用于审计与自检） */
        this.wraps = 0;
    }

    /**
     * 式(1)：相邻两帧的步长 d
     *
     *   有效序号域 [1, 65 535]，回绕路径 65 535→1，步长仍为 1。
     *   若直接以 65 536 为模，65 535→1 会被误算为 d=2（本文修正前的行为）。
     *
     * @returns {number} d = 0 重复帧；d = 1 连续；d > 1 中间丢失 d−1 帧
     */
    static step(last, seq) {
        if (seq === last) return 0;                        // 重复帧，不计缺口
        if (last === SEQ_MAX && seq === 1) return 1;       // 回绕点：步长仍为 1
        return ((seq - last) + SEQ_MOD) % SEQ_MOD;
    }

    /**
     * 收到一帧报文。seq 为 0 / null / undefined 时按"旧固件帧"处理：
     * 不计入连续性统计，也不更新基准序号（论文 §2.1 对旧固件的处理）。
     */
    onPacket({ t, seq }) {
        this.packets += 1;
        this.lastPacketAt = t;

        // 链路恢复：结算本次中断时长（论文 §4.5 可用率）
        if (this.downSince !== null) {
            this.downMs += Math.max(0, t - this.downSince);
            this.downSince = null;
        }

        const valid = seq !== null && seq !== undefined && seq !== 0;
        if (!valid) {
            if (seq === 0) this.legacyFrames += 1;         // 旧固件帧，排除
        } else if (this.lastSeq === null) {
            this.expected += 1;                            // 首帧建立基准
            this.lastSeq = seq;
        } else {
            const d = LinkMonitor.step(this.lastSeq, seq);
            if (this.lastSeq === SEQ_MAX && seq === 1) this.wraps += 1;
            if (d === 0) { /* 重复帧，不计缺口 */ }
            else if (d > 1) { this.gaps += d - 1; this.expected += d; }
            else { this.expected += 1; }
            this.lastSeq = seq;
        }

        this.state = 'GOOD';
        this.backoffStep = 0;
        this.lastGoodAt = t;
        return this.stats(t);
    }

    onError() {
        this.failures += 1;
        this.backoffStep = Math.min(this.backoffStep + 1, 16);
        this.state = 'BAD';
        // 中断开始计时（重复失败不重置起点，避免可用率被低估）
        if (this.downSince === null) this.downSince = Date.now();
    }

    /**
     * 式(4)：指数退避 τn = min(τmax, τ0·2^(n−1))，叠加 ±10% 抖动
     * 抖动在钳位后再受限，以保证间隔不超过 τmax（论文 §2.2）。
     */
    nextRetryDelay() {
        const raw = Math.min(this.cfg.maxBackoffMs, this.cfg.baseBackoffMs * Math.pow(2, Math.max(0, this.backoffStep - 1)));
        const jitter = 1 + (Math.random() * 0.2 - 0.1);
        return Math.min(this.cfg.maxBackoffMs, Math.max(1, Math.round(raw * jitter)));
    }

    /** 式(3)：三态质量码（按当前时刻判定） */
    quality(t) {
        if (this.lastPacketAt === null) return 'BAD';
        const age = t - this.lastPacketAt;
        if (age > this.cfg.badMs) return 'BAD';
        if (age > this.cfg.staleMs) return 'STALE';
        return 'GOOD';
    }

    /**
     * 丢包率区间估计（式(11) Wilson 区间）
     * 论文口径：n 为应到包数、k 为缺口数；"零缺口"（0/100）上界 3.7%。
     */
    lossCI(z = 1.96) {
        return std.lossRateCI(this.gaps, Math.max(this.expected, 1), z);
    }

    stats(t) {
        const expected = Math.max(this.expected, 1);
        const ci = this.lossCI();
        // 当前若仍处中断中，把"进行中的中断"计入累计（不修改状态，便于随时取快照）
        const now = t !== undefined ? t : Date.now();
        const ongoing = this.downSince !== null ? Math.max(0, now - this.downSince) : 0;
        return {
            packets: this.packets,
            gaps: this.gaps,
            expected: this.expected,
            lossRate: +std.packetLossRate(this.gaps, expected).toFixed(6),
            lossCI: { lo: +ci.lo.toFixed(6), hi: +ci.hi.toFixed(6), phat: +ci.phat.toFixed(6), z: ci.z },
            lastSeq: this.lastSeq,
            lastPacketAt: this.lastPacketAt,
            quality: t !== undefined ? this.quality(t) : this.state,
            failures: this.failures,
            backoffStep: this.backoffStep,
            legacyFrames: this.legacyFrames,   // 被排除的旧固件帧（序号 0）
            wraps: this.wraps,                 // 已跨越的回绕点数
            downMs: this.downMs + ongoing,     // 链路中断累计时长（可用率分子）
            inOutage: this.downSince !== null,
        };
    }

    /**
     * 写入—回读校验（论文 §2.2）
     * 回读偏差不超过容差 tol（默认 0.5）判为成功，否则重试（最多 retries + 1 次），
     * 仍不一致则判为写失败并记录。
     * @param {{write:Function, read:Function, reg:number, value:number, tol?:number, retries?:number}} o
     */
    async writeVerify(o) {
        const tol = o.tol !== undefined ? o.tol : 0.5;
        const retries = o.retries !== undefined ? o.retries : 2;
        let attempts = 0, readback = null, error = null;
        while (attempts <= retries) {
            attempts += 1;
            try {
                await o.write(o.reg, o.value);
                readback = await o.read(o.reg);
                if (readback !== null && readback !== undefined && Math.abs(readback - o.value) <= tol) {
                    const rec = { reg: o.reg, value: o.value, readback, attempts, ok: true };
                    this.writeLog.push(rec);
                    return rec;
                }
                error = `回读不一致：期望 ${o.value}，实际 ${readback}`;
            } catch (e) {
                error = String(e && e.message ? e.message : e);
            }
        }
        const rec = { reg: o.reg, value: o.value, readback, attempts, ok: false, error };
        this.writeLog.push(rec);
        return rec;
    }
}

module.exports = { LinkMonitor, SEQ_MOD, SEQ_MAX };
