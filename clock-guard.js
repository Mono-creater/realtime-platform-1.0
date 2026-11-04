/**
 * clock-guard.js —— 时钟健康检查（无第三方依赖）
 *
 * 背景：平台所有告警时间戳都取自服务器本地时钟；车端/边缘盒上报的事件时间取自车端时钟。
 * 两边任一侧没校时，就会出现"告警 20:03:12、视频 20:03:41"这种对不上的现象 ——
 * 不是协议问题，但比协议问题更难查，所以必须把它变成一项可观测指标。
 *
 * 做法：
 *   1) 平台侧：定期与 NTP 比对（UDP 123，RFC 5905 四时间戳法），NTP 不通时退化为
 *      HTTP Date 头（精度约 ±0.5 s，只用于发现"分钟级"漂移）；
 *   2) 上报侧：由 /api/alert 接收可选 clientTime，算出与平台时钟的偏差并统计分位数；
 *   3) 两侧统一用阈值判定（默认 1000 ms），超阈值标为 degraded，但不丢弃数据。
 *
 * 环境变量：
 *   NTP_SERVER          默认 ntp.aliyun.com
 *   CLOCK_HTTP_FALLBACK 默认 https://www.baidu.com（仅取 Date 头）
 *   CLOCK_CHECK_MIN     检查间隔（分钟，默认 10）
 *   CLOCK_THRESHOLD_MS  判定阈值（ms，默认 1000）
 *   CLOCK_DISABLED      =true 关闭（离线/内网环境）
 */

'use strict';

const dgram = require('dgram');

/** NTP 时间戳（1900 起算）→ Unix ms */
function readNtpMs(buf, offset) {
    const secs = buf.readUInt32BE(offset);
    const frac = buf.readUInt32BE(offset + 4);
    return (secs - 2208988800) * 1000 + (frac * 1000) / 2 ** 32;
}

/** 单次 NTP 查询：offset = ((t2−t1)+(t3−t4))/2，rtt = (t4−t1)−(t3−t2) */
function ntpQuery(server, timeoutMs) {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        let done = false;
        const finish = (err, val) => {
            if (done) return;
            done = true;
            try { sock.close(); } catch { /* 已关闭 */ }
            err ? reject(err) : resolve(val);
        };

        const t1 = Date.now();
        const packet = Buffer.alloc(48);
        packet[0] = 0x1b;                    // LI=0 VN=3 Mode=3（客户端）

        sock.on('error', (e) => finish(e));
        sock.on('message', (msg) => {
            if (!msg || msg.length < 48) return finish(new Error('NTP 响应过短'));
            try {
                const t2 = readNtpMs(msg, 32);   // 服务器接收
                const t3 = readNtpMs(msg, 40);   // 服务器发送
                const t4 = Date.now();
                finish(null, {
                    offsetMs: ((t2 - t1) + (t3 - t4)) / 2,
                    rttMs: (t4 - t1) - (t3 - t2),
                });
            } catch (e) { finish(e); }
        });

        sock.send(packet, 0, 48, 123, server, (e) => { if (e) finish(e); });
        const timer = setTimeout(() => finish(new Error('NTP 超时')), timeoutMs);
        if (timer.unref) timer.unref();
    });
}

/** HTTP Date 兜底：精度受限于秒级，只用于发现粗漂移 */
async function httpDateQuery(url, timeoutMs) {
    const t1 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
        const t4 = Date.now();
        const date = res.headers.get('date');
        if (!date) throw new Error('响应无 Date 头');
        const serverMs = Date.parse(date);
        if (!Number.isFinite(serverMs)) throw new Error('Date 头无法解析');
        return {
            offsetMs: serverMs - (t1 + t4) / 2,
            rttMs: t4 - t1,
            precisionMs: 1000,           // 秒级截断
        };
    } finally {
        clearTimeout(timer);
    }
}

function createClockGuard(opts = {}) {
    const cfg = Object.assign({
        server: process.env.NTP_SERVER || 'ntp.aliyun.com',
        httpFallback: process.env.CLOCK_HTTP_FALLBACK || 'https://www.baidu.com',
        intervalMs: (Number(process.env.CLOCK_CHECK_MIN) || 10) * 60000,
        thresholdMs: Number(process.env.CLOCK_THRESHOLD_MS) || 1000,
        timeoutMs: Number(process.env.CLOCK_TIMEOUT_MS) || 2000,
        disabled: String(process.env.CLOCK_DISABLED || '').toLowerCase() === 'true',
    }, opts);

    const state = {
        offsetMs: null,
        source: 'none',        // ntp / http / none
        precisionMs: null,
        rttMs: null,
        ok: null,
        checkedAt: null,
        error: null,
        checking: false,
    };
    let timer = null;

    async function check({ force = false } = {}) {
        if (cfg.disabled) {
            state.source = 'disabled';
            state.ok = null;
            return status();
        }
        if (state.checking && !force) return status();
        state.checking = true;
        try {
            try {
                const r = await ntpQuery(cfg.server, cfg.timeoutMs);
                Object.assign(state, {
                    offsetMs: Math.round(r.offsetMs),
                    source: 'ntp',
                    precisionMs: 10,
                    rttMs: Math.round(r.rttMs),
                    error: null,
                });
            } catch (ntpErr) {
                const r = await httpDateQuery(cfg.httpFallback, cfg.timeoutMs);
                Object.assign(state, {
                    offsetMs: Math.round(r.offsetMs),
                    source: 'http',
                    precisionMs: r.precisionMs,
                    rttMs: r.rttMs,
                    error: `NTP 不可用（${ntpErr.message}），已退化为 HTTP Date`,
                });
            }
            state.checkedAt = Date.now();
            state.ok = Math.abs(state.offsetMs) <= cfg.thresholdMs;
        } catch (err) {
            state.error = err.message;
            state.ok = null;
            state.checkedAt = Date.now();
        } finally {
            state.checking = false;
        }
        return status();
    }

    function status() {
        const ageSec = state.checkedAt ? Math.round((Date.now() - state.checkedAt) / 1000) : null;
        return {
            ...state,
            thresholdMs: cfg.thresholdMs,
            server: cfg.server,
            intervalMin: Math.round(cfg.intervalMs / 60000),
            ageSec,
            // 超过 3 个检查周期没有成功结果，视为不可信
            stale: ageSec === null || ageSec > Math.max(1800, (cfg.intervalMs / 1000) * 3),
        };
    }

    function start() {
        if (cfg.disabled) {
            state.source = 'disabled';
            return;
        }
        check();
        timer = setInterval(() => check(), cfg.intervalMs);
        if (timer.unref) timer.unref();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { start, stop, check, status, threshold: () => cfg.thresholdMs, cfg };
}

/**
 * 上报端时钟偏差统计（/api/alert 携带 clientTime 时记录）
 * 只需要最近若干条即可看出分布，故用固定长度环形数组，不落库。
 */
function createSkewTracker(limit = 200) {
    const samples = [];
    let degraded = 0;
    let total = 0;

    function push({ skewMs, code, source }) {
        total += 1;
        samples.push({ at: Date.now(), code: code || '--', skewMs: Math.round(skewMs), source: source || 'client' });
        if (samples.length > limit) samples.shift();
    }

    function markDegraded() { degraded += 1; }

    function stats() {
        if (!samples.length) {
            return { count: 0, total, degraded, p50: null, p95: null, max: null, last: null };
        }
        const abs = samples.map((s) => Math.abs(s.skewMs)).sort((a, b) => a - b);
        // 最近秩法（nearest-rank）：p50 取中位，p95 在小样本下自然回退到最大值
        const q = (p) => abs[Math.min(abs.length - 1, Math.ceil(p * abs.length) - 1)];
        return {
            count: samples.length,
            total,
            degraded,
            p50: q(0.5),
            p95: q(0.95),
            max: abs[abs.length - 1],
            last: samples[samples.length - 1],
        };
    }

    return { push, markDegraded, stats, samples };
}

module.exports = { createClockGuard, createSkewTracker, ntpQuery, httpDateQuery, readNtpMs };
