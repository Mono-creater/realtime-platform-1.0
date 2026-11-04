#!/usr/bin/env node
/**
 * bench_bridge.js —— 把真实 PLC（或 plc-simulator）的寄存器采样送入平台 v2 判据链
 *
 * 背景：server.js 的 v1 实时采集只更新 UI/DB 与 v1 告警，不调用 /api/v2/*
 *       的 LinkMonitor / EWMA / 自适应 / RUL。台架要验证论文判据，必须另起本桥。
 *
 * 用法（在 D:\realtime-platform1.0 下）：
 *   node tools/bench_bridge.js --host 192.168.1.88 --port 502 --unit 1 \
 *       --interval 1000 --api http://127.0.0.1:3000 --duration 4800 \
 *       --out bench_S4.jsonl --label S4
 *
 * 常用参数：
 *   --host       PLC IP（模拟器 127.0.0.1）
 *   --port       PLC 端口（真实 502，模拟器 1502）
 *   --unit       从站号（默认 1）
 *   --interval   采样/上报周期 ms（链路试验必须与 PLC 组包周期一致，默认 1000）
 *   --api        平台地址（默认 http://127.0.0.1:3000）
 *   --duration   运行时长 s（默认 4800 = 80 min）
 *   --out        JSONL 输出路径
 *   --label      设备/场景标识，写入 deviceId
 *   --token      API_TOKEN（若 .env 启用了写接口令牌）
 *   --drop       应用层丢帧概率（0~1，默认 0；用于链路试验注入）
 *   --drop-schedule  分段丢帧，例 "0:600:0.01,600:1200:0.03,1200:1800:0.05"（秒:秒:概率）
 *   --verbose    逐条打印
 */
'use strict';

const fs = require('fs');
const ModbusRTU = require('modbus-serial');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const HOST = arg('--host', process.env.PLC_HOST || '127.0.0.1');
const PORT = parseInt(arg('--port', process.env.PLC_PORT || '1502'), 10);
const UNIT = parseInt(arg('--unit', process.env.PLC_UNIT_ID || '1'), 10);
const INTERVAL = parseInt(arg('--interval', '1000'), 10);
const API = arg('--api', 'http://127.0.0.1:3000');
const DURATION = parseInt(arg('--duration', '4800'), 10);
const OUT = arg('--out', `bench_${Date.now()}.jsonl`);
const LABEL = arg('--label', 'bench');
const TOKEN = arg('--token', process.env.API_TOKEN || '');
const DROP = Math.max(0, Math.min(1, parseFloat(arg('--drop', '0'))));
const SCHEDULE = arg('--drop-schedule', ''); // 例：0:600:0.01,600:1200:0.03,1200:1800:0.05
const VERBOSE = process.argv.includes('--verbose');

const SEGMENTS = SCHEDULE
    ? SCHEDULE.split(',').map((s) => {
        const [from, to, p] = s.split(':').map(Number);
        return { from, to, p: Math.max(0, Math.min(1, p)) };
    })
    : [];
function dropProb(elapsedSec) {
    if (SEGMENTS.length) {
        const seg = SEGMENTS.find((s) => elapsedSec >= s.from && elapsedSec < s.to);
        if (seg) return seg.p;
    }
    return DROP;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeTemp(raw) {
    return (raw > 32767 ? raw - 65536 : raw) / 10;
}

let client = null;

async function connect() {
    client = new ModbusRTU();
    await client.connectTCP(HOST, { port: PORT });
    client.setID(UNIT);
    client.setTimeout(800);
}

async function main() {
    await connect();
    console.log(`[bridge] PLC ${HOST}:${PORT} unit=${UNIT} interval=${INTERVAL}ms api=${API} label=${LABEL}`);
    const out = fs.createWriteStream(OUT, { flags: 'a' });
    const t0 = Date.now();
    let n = 0, posted = 0, dropped = 0, errors = 0, alarms = 0;

    while (Date.now() - t0 < DURATION * 1000) {
        const tick = Date.now();
        try {
            const r = await client.readHoldingRegisters(2001, 5);
            const [tRaw, pRaw, hRaw, status, seq] = r.data;
            const sample = {
                t: Date.now(),
                temperature: decodeTemp(tRaw),
                pressure: pRaw / 10,
                humidity: hRaw / 10,
                seq,
                deviceId: LABEL,
            };

            // 异常子包（只记录，v2 ingest 不使用位图；位图语义走 v1 链路验证）
            let sub = null;
            if ((status & 0x80) !== 0) {
                try {
                    const s = await client.readHoldingRegisters(2011, 5);
                    sub = {
                        seq: s.data[0],
                        bitmap: s.data[1],
                        temperature: decodeTemp(s.data[2]),
                        pressure: s.data[3] / 10,
                        humidity: s.data[4] / 10,
                    };
                } catch (e) {
                    sub = { error: e.message };
                }
            }

            if (Math.random() < dropProb((Date.now() - t0) / 1000)) {
                dropped += 1;
            } else {
                const headers = { 'Content-Type': 'application/json' };
                if (TOKEN) headers['X-API-Token'] = TOKEN;
                const resp = await fetch(`${API}/api/v2/ingest`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(sample),
                });
                const body = await resp.json().catch(() => ({ error: 'non-json response' }));
                if (Array.isArray(body.alarms)) alarms += body.alarms.length;
                out.write(JSON.stringify({ sample, status, sub, http: resp.status, resp: body }) + '\n');
                posted += 1;
                if (VERBOSE) {
                    console.log(
                        `[${posted}] seq=${seq} T=${sample.temperature.toFixed(1)} ` +
                        `P=${sample.pressure.toFixed(1)} H=${sample.humidity.toFixed(1)} ` +
                        `alarms=${(body.alarms || []).length} loss=${body.link ? body.link.lossRate : '-'}`
                    );
                }
            }
            n += 1;
        } catch (e) {
            errors += 1;
            console.error(`[bridge] ERR ${new Date().toISOString()} ${e.message}`);
            try { await client.close(); } catch (e2) { /* ignore */ }
            await sleep(1000);
            try { await connect(); } catch (e3) { console.error(`[bridge] reconnect failed: ${e3.message}`); }
        }

        const wait = tick + INTERVAL - Date.now();
        if (wait > 0) await sleep(wait);
    }

    out.end();
    console.log(`[bridge] done samples=${n} posted=${posted} dropped=${dropped} errors=${errors} alarms=${alarms} out=${OUT}`);
    try { await client.close(); } catch (e) { /* ignore */ }
}

main().catch((e) => {
    console.error('[bridge] fatal', e);
    process.exit(1);
});
