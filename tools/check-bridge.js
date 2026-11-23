#!/usr/bin/env node
/**
 * check-bridge.js —— 无线网桥「环境参数 + 图传」一体自检（零新增依赖）
 *
 * 用途：一条命令同时验证 5.8G 网桥链路上的两类业务
 *   ① 环境参数（气压/温度/湿度）：Modbus TCP 读 2001-2005，按 plc-packet 解码
 *   ② 图传：相机快照 HTTP 抓取 + RTSP 554 端口探测
 *
 * 用法：
 *   node tools/check-bridge.js                     # 读 .env / 环境变量
 *   node tools/check-bridge.js --plc 192.168.1.10 --port 502
 *   node tools/check-bridge.js --cam 192.168.1.88 --rounds 10
 *   node tools/check-bridge.js --no-cam            # 只测环境参数
 *   node tools/check-bridge.js --json              # 机器可读输出（供 CI/批处理）
 *
 * 退出码：0 全通 / 1 有业务不通 / 2 参数错误
 */
'use strict';

const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const ModbusRTU = require('modbus-serial');
const { parseMainPacket } = require(path.join(__dirname, '..', 'plc-packet.js'));

// ---------- 参数 ----------
function arg(name, def) {
    const i = process.argv.indexOf(name);
    if (i === -1) return def;
    const v = process.argv[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
}
const envFile = path.join(__dirname, '..', '.env');
const env = {};
if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}
const pick = (k, d) => (process.env[k] !== undefined ? process.env[k] : env[k] !== undefined ? env[k] : d);

const PLC_HOST = String(arg('--plc', pick('PLC_HOST', '192.168.1.10')));
const PLC_PORT = parseInt(arg('--port', pick('PLC_PORT', '502')), 10);
const PLC_UNIT = parseInt(arg('--unit', pick('PLC_UNIT_ID', '1')), 10);
const REG_BASE = parseInt(arg('--reg', pick('PLC_REG_TEMP', '2001')), 10);
const CAM_IP = String(arg('--cam', pick('CAM1_IP', '192.168.1.88')));
const CAM_USER = pick('CAM1_USER', 'admin');
const CAM_PASS = pick('CAM1_PASS', '12345678a');
const CAM_SNAP = String(arg('--snap', pick('CAM_SNAP_PATH', '/tmpfs/auto.jpg')));
const CAM_PORT = parseInt(arg('--cam-port', pick('CAM_PORT', '80')), 10);
const ROUNDS = Math.max(1, Math.min(50, parseInt(arg('--rounds', '5'), 10)));
const TEST_CAM = arg('--no-cam', false) !== true;
const JSON_OUT = arg('--json', false) === true;
const TIMEOUT = parseInt(arg('--timeout', '3000'), 10);

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

const stats = (arr) => {
    if (!arr.length) return { n: 0 };
    const s = [...arr].sort((a, b) => a - b);
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const jitter = Math.sqrt(arr.reduce((a, b) => a + (b - avg) ** 2, 0) / arr.length);
    return { n: arr.length, avg: +avg.toFixed(1), min: +s[0].toFixed(1), max: +s[s.length - 1].toFixed(1), jitter: +jitter.toFixed(1), p95: +s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)].toFixed(1) };
};

const tcpProbe = (host, port, ms = TIMEOUT) => new Promise((res) => {
    const t0 = Date.now();
    const s = new net.Socket();
    let done = false;
    const fin = (ok) => { if (!done) { done = true; s.destroy(); res({ ok, ms: Date.now() - t0 }); } };
    s.setTimeout(ms);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
});

// ---------- ① 环境参数 ----------
async function probeModbus() {
    const out = { target: `${PLC_HOST}:${PLC_PORT}`, ok: false, rtts: [], samples: [], error: null };
    const t = await tcpProbe(PLC_HOST, PLC_PORT);
    if (!t.ok) { out.error = `TCP ${PLC_PORT} 不通`; out.connectMs = t.ms; return out; }
    out.connectMs = t.ms;

    const client = new ModbusRTU();
    try {
        await client.connectTCP(PLC_HOST, { port: PLC_PORT });
        client.setID(PLC_UNIT);
        client.setTimeout(TIMEOUT);
        for (let i = 0; i < ROUNDS; i++) {
            const t0 = process.hrtime.bigint();
            const r = await client.readHoldingRegisters(REG_BASE, 5);
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            out.rtts.push(+ms.toFixed(1));
            out.samples.push(parseMainPacket(r.data));
        }
        out.ok = true;
    } catch (e) {
        out.error = e.message;
    } finally {
        try { client.close(() => {}); } catch (_) {}
    }
    return out;
}

// ---------- ② 图传 ----------
async function probeCamera() {
    const out = { target: `${CAM_IP}:${CAM_PORT}/554`, ok: false, snapMs: [], bytes: 0, rtsp: null, error: null };
    const auth = 'Basic ' + Buffer.from(`${CAM_USER}:${CAM_PASS}`).toString('base64');
    for (let i = 0; i < Math.min(ROUNDS, 5); i++) {
        try {
            const t0 = Date.now();
            const r = await fetch(`http://${CAM_IP}${CAM_PORT === 80 ? '' : ':' + CAM_PORT}${CAM_SNAP}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(TIMEOUT) });
            const b = Buffer.from(await r.arrayBuffer());
            if (!r.ok) { out.error = `快照 HTTP ${r.status}`; break; }
            out.snapMs.push(Date.now() - t0);
            out.bytes = b.length;
            out.ok = b.length > 1024;
            if (!out.ok) { out.error = `快照仅 ${b.length} B`; break; }
        } catch (e) { out.error = e.message; break; }
    }
    out.rtsp = await tcpProbe(CAM_IP, 554);
    return out;
}

// ---------- ③ 本机网卡 ----------
function localIfaces() {
    const list = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces()))
        for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) list.push({ name, ip: a.address, netmask: a.netmask });
    return list;
}

(async () => {
    const result = { at: new Date().toISOString(), host: PLC_HOST, ifaces: localIfaces() };

    log(c.b(`\n=== 网桥链路自检 ${new Date().toLocaleString('zh-CN')} ===`));
    log(c.b('[0] 本机网卡'));
    if (!result.ifaces.length) log(c.r('  ✘ 没有任何可用 IPv4 网卡（网线未插 / 网桥未上电）'));
    for (const i of result.ifaces) {
        const sameSubnet = i.ip.startsWith('192.168.1.');
        log(`  ${sameSubnet ? c.g('✔') : c.y('!')} ${i.name} → ${i.ip}/${i.netmask}${sameSubnet ? '' : '  （与业务网段 192.168.1.x 不同）'}`);
    }

    log(c.b('[1] 环境参数 Modbus TCP'));
    const mb = await probeModbus();
    result.modbus = { ...mb, stats: stats(mb.rtts) };
    if (mb.ok) {
        const s = mb.samples[mb.samples.length - 1];
        log(`  ${c.g('✔')} 连接 ${mb.target} 首连 ${mb.connectMs} ms`);
        log(`  ${c.g('✔')} 读 ${ROUNDS} 次 ${REG_BASE}~${REG_BASE + 4}：温度 ${s.temperature} ℃ / 气压 ${s.pressure} kPa / 湿度 ${s.humidity} %`);
        log(`  ${c.g('✔')} 状态字 0x${s.status.toString(16).padStart(2, '0')} 序号 ${s.seq} 扩展协议 ${s.extended ? '是' : '否'} 子包有效 ${s.subValid ? '是' : '否'}`);
        const st = result.modbus.stats;
        log(`      RTT 均值 ${st.avg} ms / 最大 ${st.max} ms / 抖动 ${st.jitter} ms`);
        if (st.max > 200) log(c.y('      ! 单次 RTT > 200 ms，2 s 轮询下会与下一周期叠加，考虑拉长 PLC_INTERVAL'));
    } else {
        log(`  ${c.r('✘')} ${mb.target} ${mb.error}`);
        log(c.y('      ▶ 检查：PLC/温压湿变送器是否上电、网线是否接网桥 A 的 LAN 口、IP 是否 192.168.1.x、端口是 502（真实）还是 1502（模拟器）'));
    }

    if (TEST_CAM) {
        log(c.b('[2] 图传'));
        const cam = await probeCamera();
        result.camera = { ...cam, stats: stats(cam.snapMs) };
        if (cam.ok) {
            log(`  ${c.g('✔')} 快照 ${CAM_IP}${CAM_SNAP} ${(cam.bytes / 1024).toFixed(1)} KB，RTT 均值 ${result.camera.stats.avg ?? cam.snapMs[0]} ms`);
        } else {
            log(`  ${c.r('✘')} 快照取不到：${cam.error}`);
        }
        if (cam.rtsp && cam.rtsp.ok) log(`  ${c.g('✔')} RTSP 554 可连（${cam.rtsp.ms} ms），主码流 rtsp://${CAM_USER}:***@${CAM_IP}:554/11`);
        else log(c.y(`  ! RTSP 554 不通（快照可用时仅影响视频切片，不影响抓帧图传）`));
    }

    // ---------- 结论 ----------
    const pass = mb.ok && (!TEST_CAM || result.camera.ok);
    log(c.b('[结论]'));
    log(`  环境参数：${mb.ok ? c.g('通') : c.r('断')}   图传：${TEST_CAM ? (result.camera.ok ? c.g('通') : c.r('断')) : c.y('跳过')}`);
    log(pass
        ? c.g('  ✔ 两类业务均可在该链路承载：环境参数走 Modbus TCP（31 B/次@2 s），图传走 HTTP 快照 + RTSP 切片，互不干扰。')
        : c.r('  ✘ 有业务不通，先修链路再谈采集。'));

    if (JSON_OUT) { result.pass = pass; console.log(JSON.stringify(result, null, 2)); }
    process.exitCode = pass ? 0 : 1;
})();
