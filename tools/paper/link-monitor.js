/**
 * link-monitor.js —— 通信链路质量与写操作校验（行业需求：数据可信、写操作可验证、断链可恢复）
 *
 * 功能：
 *  1) 报文序号连续性检查 → 丢包率（支持 16 位序号回绕，与 PLC 侧语义一致）；
 *  2) 数据新鲜度（staleness）与质量码 GOOD/STALE/BAD，供前端标注与告警抑制；
 *  3) 心跳超时判定与指数退避重连（避免雪崩式重连）；
 *  4) 写操作“写入—回读”校验（write-verify）：控制输出写寄存器后回读比对，
 *     偏差超限即判定写失败，防止“以为写了、实际没写”的隐性失效；
 *  5) 统计指标：应到包数/缺口数/丢包率/连续正常时长。
 *
 * 依据：GB/T 30976 系列对工业控制系统“数据完整性、操作可审计、最小权限”的要求；
 *       Modbus 应用协议规范（无内建校验，需应用层补充序号与回读校验）。
 * 无第三方依赖。
 */

'use strict';

const std = require('./standards');

const SEQ_MOD = 65535;
// 说明：序号有效域为 [1, 65535]，回绕路径为 65535→1，故步长应取模 65535。
//      原实现取模 65536，会在每个回绕点把 65535→1 误算为 d=2，凭空产生 1 个虚假缺口
//      （对应论文表 6 的"完整回绕周期…处理后缺口数 0"这一应满足而未满足的声明）。

class LinkMonitor {
    constructor(opts = {}) {
        this.cfg = Object.assign({
            expectedIntervalMs: 1000,   // 预期报文周期
            staleMs: 3000,              // 超过该时长未收到报文 → STALE
            badMs: 10000,               // 超过该时长 → BAD
            heartbeatTimeoutMs: 5000,
            baseBackoffMs: 500,
            maxBackoffMs: 8000,
        }, opts);
        this.packets = 0; this.gaps = 0; this.expected = 0;
        this.lastSeq = null; this.lastPacketAt = null;
        this.lastGoodAt = null; this.state = 'GOOD';
        this.failures = 0; this.backoffStep = 0;
        this.writeLog = [];
    }

    /** 收到一帧报文 */
    onPacket({ t, seq }) {
        this.packets += 1;
        this.lastPacketAt = t;
        // seq 有效域为 [1, 65535]；seq=0 为旧固件保留值，不参与连续性统计，
        // 避免"恢复后把 0 当作基准序号而一次性产生大量虚假缺口"。
        const hasSeq = seq !== null && seq !== undefined && seq !== 0;
        if (hasSeq) {
            if (this.lastSeq !== null) {
                const delta = (seq - this.lastSeq + SEQ_MOD) % SEQ_MOD;
                if (delta === 0) { /* 重复帧，不计缺口 */ }
                else if (delta > 1) { this.gaps += delta - 1; this.expected += delta; }
                else { this.expected += 1; }
            } else {
                this.expected += 1;
            }
            this.lastSeq = seq;
        }
        this.state = 'GOOD';
        this.backoffStep = 0;
        return this.stats(t);
    }

    onError() {
        this.failures += 1;
        this.backoffStep = Math.min(this.backoffStep + 1, 16);
        this.state = 'BAD';
    }

    /** 指数退避：base·2^(n-1)，上限 maxBackoff，含 ±10% 抖动 */
    nextRetryDelay() {
        const raw = Math.min(this.cfg.maxBackoffMs, this.cfg.baseBackoffMs * Math.pow(2, Math.max(0, this.backoffStep - 1)));
        const jitter = 1 + (Math.random() * 0.2 - 0.1);
        return Math.round(raw * jitter);
    }

    /** 质量码（按当前时刻判定） */
    quality(t) {
        if (this.lastPacketAt === null) return 'BAD';
        const age = t - this.lastPacketAt;
        if (age > this.cfg.badMs) return 'BAD';
        if (age > this.cfg.staleMs) return 'STALE';
        return 'GOOD';
    }

    stats(t) {
        const expected = Math.max(this.expected, 1);
        return {
            packets: this.packets,
            gaps: this.gaps,
            expected: this.expected,
            lossRate: +std.packetLossRate(this.gaps, expected).toFixed(4),
            lastSeq: this.lastSeq,
            lastPacketAt: this.lastPacketAt,
            quality: t !== undefined ? this.quality(t) : this.state,
            failures: this.failures,
            backoffStep: this.backoffStep,
        };
    }

    /**
     * 写入—回读校验
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

module.exports = { LinkMonitor, SEQ_MOD };
