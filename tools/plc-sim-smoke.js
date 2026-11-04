/**
 * tools/plc-sim-smoke.js —— 模拟器端到端冒烟测试
 * 作用：以 Modbus TCP 客户端身份连接模拟器，读取主包/子包寄存器并按协议解码，
 *       再写回控制寄存器（2021/2022），验证“平台↔模拟器”链路可用。
 * 用法：先启动模拟器（npm run plc-sim），再执行 node tools/plc-sim-smoke.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ModbusRTU = require('modbus-serial');
const pkt = require('../plc-packet');

const ROOT = path.join(__dirname, '..');
function envMap() {
    const map = {};
    try {
        for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
            if (m) map[m[1]] = m[2];
        }
    } catch (e) { /* 无 .env 时用默认值 */ }
    return map;
}
const env = envMap();
const HOST = env.PLC_HOST || '127.0.0.1';
const PORT = parseInt(env.PLC_PORT || '1502', 10);
const UNIT = parseInt(env.PLC_UNIT_ID || '1', 10);
const R = {
    temp: parseInt(env.PLC_REG_TEMP || '2001', 10),
    press: parseInt(env.PLC_REG_PRESS || '2002', 10),
    humid: parseInt(env.PLC_REG_HUMID || '2003', 10),
    status: parseInt(env.PLC_REG_STATUS || '2004', 10),
    seq: parseInt(env.PLC_REG_SEQ || '2005', 10),
    sub: parseInt(env.PLC_REG_SUB_BASE || '2011', 10),
    wForce: parseInt(env.PLC_REG_WRITE_FORCE || '2021', 10),
    wHeight: parseInt(env.PLC_REG_WRITE_HEIGHT || '2022', 10),
};

(async () => {
    const client = new ModbusRTU();
    console.log(`连接模拟器 ${HOST}:${PORT}（从站号 ${UNIT}）...`);
    await client.connectTCP(HOST, { port: PORT });
    client.setID(UNIT);

    const main = await client.readHoldingRegisters(R.temp, 5);
    const parsed = pkt.parseMainPacket(main.data);
    console.log('[主包] 寄存器 =', main.data.join(', '));
    console.log(`       温度=${parsed.temperature}°C  压力=${parsed.pressure}kPa  湿度=${parsed.humidity}%  序号=${parsed.seq}  扩展协议=${parsed.extended}  异常位图=${parsed.anomalyBitmap}`);

    const sub = await client.readHoldingRegisters(R.sub, 5);
    const subParsed = pkt.parseSubPacket(sub.data);
    console.log('[子包] 寄存器 =', sub.data.join(', '));
    console.log(`       子包序号=${subParsed.subSeq}  位图=${subParsed.bitmap}  异常值=`, subParsed.values);

    const anomalies = pkt.anomaliesFromBitmap(parsed.anomalyBitmap, parsed);
    console.log(`[异常判定] 当前异常条数 = ${anomalies.length}`, anomalies.map(a => a.type).join('、'));

    // 写控制寄存器（模拟平台下发：气囊压力 100.0kPa、弓头高度 2400mm）
    await client.writeRegisters(R.wForce, [1000]);
    await client.writeRegisters(R.wHeight, [2400]);
    console.log(`[写回] 已写 ${R.wForce}=1000（100.0kPa）、${R.wHeight}=2400（mm）`);

    const rb1 = await client.readHoldingRegisters(R.wForce, 1);
    const rb2 = await client.readHoldingRegisters(R.wHeight, 1);
    console.log(`[回读] ${R.wForce}=${rb1.data[0]}  ${R.wHeight}=${rb2.data[0]}`);
    const okWrite = rb1.data[0] === 1000 && rb2.data[0] === 2400;

    await client.close();
    console.log('');
    console.log(okWrite ? '✓ 冒烟测试通过：模拟器可读、可写、可回读，协议解析正常' : '✗ 冒烟测试失败：写回读不一致');
    process.exit(okWrite ? 0 : 1);
})().catch((err) => {
    console.error('✗ 冒烟测试失败：', err && err.message ? err.message : err);
    console.error('  请确认模拟器已启动（npm run plc-sim），且 .env 的 PLC_HOST/PLC_PORT/PLC_UNIT_ID 与之一致。');
    process.exit(1);
});
