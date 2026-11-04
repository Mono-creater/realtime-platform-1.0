/**
 * exp_link_longrun.js —— 半实物链路长时试验（论文 §4.3 补强）
 * 真实 Modbus TCP 协议栈 + PLC 从站模拟器；按 1 s 轮询持续 duration 秒。
 * 分三段注入 1% / 2% / 5% 丢帧，统计：实际收到帧数、注入丢帧数、估计丢包率与偏差。
 * 用法：先启动 PLC 模拟器（node plc-simulator.js --port 1502），
 *       再 node tools/exp_link_longrun.js --duration 1800 --seg 600
 */
'use strict';
const ModbusRTU = require('modbus-serial');
const { LinkMonitor } = require('../link-monitor.js');
const fs = require('fs');

function arg(name, def) { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : def; }
const HOST = arg('--host', '127.0.0.1');
const PORT = parseInt(arg('--port', '1502'), 10);
const UNIT = parseInt(arg('--unit', '1'), 10);
const DUR = parseInt(arg('--duration', '1800'), 10);
const SEG = parseInt(arg('--seg', '600'), 10);
const PERIOD = parseInt(arg('--period', '1000'), 10);
const LOSS = [0.01, 0.03, 0.05];   // 论文12.8 口径：1% / 3% / 5% 三段
const OUT = arg('--out', 'tools/exp_link_longrun.json');

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
const rnd = rng(20261017);

(async () => {
    const client = new ModbusRTU();
    await client.connectTCP(HOST, { port: PORT });
    client.setID(UNIT);
    client.setTimeout(800);
    const lm = new LinkMonitor({ expectedIntervalMs: PERIOD });
    // 每个丢包档位独立的计数器（修复：原版 seg!==phases.length 的判定会丢失计数）
    const phases = LOSS.map(loss => ({ loss, recv: 0, drop: 0, err: 0, firstSeq: null, lastSeq: null }));
    const started = Date.now();
    for (let t = 0; t < DUR; t += 1) {
        const seg = Math.min(LOSS.length - 1, Math.floor(t / SEG));
        const ph = phases[seg];
        if (rnd() < ph.loss) { ph.drop++; }
        else {
            try {
                const r = await client.readHoldingRegisters(2001, 5);
                const seq = r.data[4];
                if (ph.firstSeq === null) ph.firstSeq = seq;
                ph.lastSeq = seq;
                ph.recv++;
                lm.onPacket({ t: t * 1000, seq });
            } catch (e) { ph.err++; ph.drop++; }
        }
        const wait = started + (t + 1) * PERIOD - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
    const totalRecv = phases.reduce((a, b) => a + b.recv, 0);
    const totalDrop = phases.reduce((a, b) => a + b.drop, 0);
    const totalErr = phases.reduce((a, b) => a + b.err, 0);
    const out = {
        host: HOST, port: PORT, period: PERIOD, duration: DUR,
        totalRecv, totalDrop, totalErr,
        gaps: lm.gaps, expected: lm.expected, wraps: lm.wraps, legacy: lm.legacyFrames,
        estLoss: lm.expected ? lm.gaps / lm.expected : null,
        injectedLoss: totalDrop / Math.max(1, totalRecv + totalDrop),
        phases: phases.map(p => ({
            loss: p.loss, recv: p.recv, drop: p.drop, err: p.err,
            firstSeq: p.firstSeq, lastSeq: p.lastSeq,
            actual: (p.recv + p.drop) ? p.drop / (p.recv + p.drop) : null,
            estLoss: null,
        })),
        finishedAt: new Date().toISOString(),
    };
    // 每段的估计丢包率：用该段首末序号差（段内跳变）近似
    for (const p of out.phases) {
        if (p.lastSeq !== null && p.firstSeq !== null) {
            let span = p.lastSeq - p.firstSeq + 1;
            span += lm.wraps * 65536;   // 跨回绕修正（长试验时可能跨越）
            p.estLoss = span > 0 ? 1 - p.recv / span : null;
        }
    }
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    await client.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
