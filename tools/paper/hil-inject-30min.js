// hil-inject-30min.js —— 半实物 30 min 注入试验（论文12.7 §4.3 口径重新生成）
// 连接真实 Modbus TCP 从站（plc-simulator.js，端口 1502），1 s 轮询 × 30 min（1 800 帧）。
// 客户端按三段注入丢帧：0~10 min 丢 1%、10~20 min 丢 3%、20~30 min 丢 5%（确定性种子），
// 丢帧 = 该 1 s 时隙不发送请求（链路真实丢失该事务），模拟无线链路丢包。
// 估计侧：平台 LinkMonitor（序号连续性 + Wilson 区间），与注入真值对比。
// 前置：node ../../plc-simulator.js --interval 1000（另开进程；扫描周期必须 1 s，使 seq 每轮询 +1，
//   与 C-1 真实 PLC 口径一致——默认 100 ms 时 seq 每 10 次扫描 +1，LinkMonitor 会把扫描节拍差计入丢包）。
// 运行：NODE_PATH 指向含 modbus-serial 的 node_modules；HIL_DURATION_MS 可缩短时长用于冒烟。
'use strict';
const fs = require('fs');
const path = require('path');
const ModbusRTU = require('modbus-serial');
const pkt = require('../../plc-packet.js');
const { LinkMonitor } = require('../../link-monitor.js');

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }

(async () => {
    const client = new ModbusRTU();
    await client.connectTCP('127.0.0.1', { port: 1502 });
    client.setID(1);

    const POLL = 1000, DURATION = parseInt(process.env.HIL_DURATION_MS || 1800000, 10);   // 1 s × 1800 帧 = 30 min
    const SEGMENTS = [
        { from: 0, to: 600, drop: 0.01 },     // 0~10 min：1%
        { from: 600, to: 1200, drop: 0.03 },  // 10~20 min：3%
        { from: 1200, to: 1800, drop: 0.05 }, // 20~30 min：5%
    ];
    const dropRng = rng(20261018 + 43);
    const rows = [];
    const lm = new LinkMonitor();
    let attempts = 0, dropped = 0, packets = 0, anomalyFrames = 0, totalBytes = 0;
    const t0 = Date.now();

    while (Date.now() - t0 < DURATION) {
        const i = attempts;
        const seg = SEGMENTS.find((s) => i >= s.from && i < s.to);
        attempts++;
        const drop = dropRng() < seg.drop;
        if (drop) {
            dropped++;
            rows.push({ i, t_ms: Date.now(), drop: 1, seq: '', temp_C: '', bitmap: '' });
            await new Promise((r) => setTimeout(r, Math.max(0, POLL - (Date.now() - t0 - i * POLL))));
            continue;
        }
        const t = Date.now();
        try {
            const main = await client.readHoldingRegisters(2001, 5);
            const mp = pkt.parseMainPacket(main.data);
            totalBytes += 31; packets += 1;
            if (mp.seq !== 0) lm.onPacket({ t, seq: mp.seq });
            let sub = null;
            if (mp.subValid && mp.anomalyBitmap !== 0) {
                const s = await client.readHoldingRegisters(2011, 5);
                const sp = pkt.parseSubPacket(s.data);
                totalBytes += 31; anomalyFrames += 1;
                sub = { subSeq: sp.subSeq, bitmap: sp.bitmap, values: sp.values };
            }
            rows.push({
                i, t_ms: t, drop: 0, seq: mp.seq, temp_C: mp.temperature,
                bitmap: mp.anomalyBitmap, sub: sub ? `${sub.bitmap}` : '',
            });
        } catch (e) {
            rows.push({ i, t_ms: Date.now(), drop: 0, seq: 'ERR', temp_C: '', bitmap: '' });
        }
        await new Promise((r) => setTimeout(r, Math.max(0, POLL - (Date.now() - t))));
    }
    await client.close();

    const st = lm.stats(Date.now());
    const injectedRate = dropped / attempts;
    const csv = '﻿' + ['i', 't_ms', 'drop', 'seq', 'temp_C', 'bitmap', 'sub'].join(',') + '\n'
        + rows.map((r) => [r.i, r.t_ms, r.drop, r.seq, r.temp_C, r.bitmap, r.sub].join(',')).join('\n');
    const outDir = path.join(__dirname, '..', '..', 'data', 'hil-inject-30min');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, '半实物30min注入.csv'), csv, 'utf8');
    const report = [
        '==== 半实物 30 min 注入试验统计 ====',
        `轮询 1 s × ${Math.round(DURATION / 1000)} s：应发 ${attempts} 帧，注入丢失 ${dropped} 帧（${(injectedRate * 100).toFixed(2)}%）`,
        `分段注入：0~10 min 1%（${rows.filter((r) => r.i < 600 && r.drop).length} 帧）、10~20 min 3%（${rows.filter((r) => r.i >= 600 && r.i < 1200 && r.drop).length} 帧）、20~30 min 5%（${rows.filter((r) => r.i >= 1200 && r.drop).length} 帧）`,
        `接收 ${packets} 帧（异常子包 ${anomalyFrames} 帧，事务 ${totalBytes} B）`,
        `LinkMonitor 估计丢包率 = ${(st.lossRate * 100).toFixed(2)}%（gaps=${st.gaps}，expected=${st.expected}）`,
        `Wilson 95%CI = [${(st.lossCI.lo * 100).toFixed(2)}%, ${(st.lossCI.hi * 100).toFixed(2)}%]`,
        `注入真值 ${(injectedRate * 100).toFixed(2)}% vs 估计 ${(st.lossRate * 100).toFixed(2)}%（偏差 ${((st.lossRate - injectedRate) * 100).toFixed(2)} 个百分点）`,
        `数据文件：data/hil-inject-30min/半实物30min注入.csv`,
    ].join('\n');
    fs.writeFileSync(path.join(outDir, '统计.txt'), report, 'utf8');
    console.log(report);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
