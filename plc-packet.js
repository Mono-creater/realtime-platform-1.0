// ============================================================
// PLC 报文协议模块（汇川 Easy320 ⇄ 平台，Modbus TCP）
//
// 寄存器映射（协议原地址，modbus-serial 不做 40001 偏移）：
//   2001-2003    主包：温度/压力/湿度 10 次均值（×10 有符号 / ×10 / ×10）
//   2004         状态字：bit0/1/2 = 温/压/湿异常
//                        bit6 = 扩展协议标志（新固件恒置 0x40）
//                        bit7 = 异常子包有效
//   2005         主包序号（uint16，65535→1 回绕，0 = 旧固件）
//   2011         子包序号（= 异常时主包序号）
//   2012         异常位图（bit0-2 同状态字）
//   2013-2015    异常值（温度/压力/湿度，仅对应位有效）
//   2021         接触力环输出 = 气囊压力设定（×10 kPa）     W (FC16)
//   2022         姿态环输出   = 弓头高度设定（mm）          W (FC16)
//
// 段说明：Easy320 属汇川 Easy 系列，D 区从 D0 起编址，不存在 D2001。
//   参考程序 plc-program/Easy320_main.st 使用 D2001-D2022，
//   平台 .env 的 PLC_REG_* 必须落在同一段，否则读回全 0 或数据错位。
// 注：压力一律 ×10（0.1kPa 精度）。原 ×100 在高压异常 1000kPa 时
//     100000 > uint16 上限 65535，会触发 Modbus 异常码 4；×10 后
//     10000 安全落入 uint16，且编码时钳位保证不越界。
//
// 纯函数模块，server.js 与 plc-simulator.js 共用（单一阈值来源）。
// ============================================================

// 异常阈值（与平台 analyzeFault 共用，避免两处漂移）
const THRESHOLDS = {
    tempHigh: 80,    // °C  高温预警
    tempLow: -10,    // °C  低温预警
    pressHigh: 1000, // kPa 高压报警
    pressLow: 100,   // kPa 低压报警
    humidHigh: 85    // %   高湿预警
};

// 状态字位定义
const STATUS_BITS = {
    tempAnomaly: 1 << 0,
    pressAnomaly: 1 << 1,
    humidAnomaly: 1 << 2,
    extended: 1 << 6,   // 扩展协议标志：新固件恒置
    subValid: 1 << 7    // 子包有效：当前周期存在异常
};

// 16 位补码 → 有符号数
function toSigned16(raw) {
    return raw > 32767 ? raw - 65536 : raw;
}

// 定点数还原：温度 ×10（有符号）、压力 ×10、湿度 ×10
function decodeTemperature(raw) { return toSigned16(raw) / 10; }
function decodePressure(raw) { return raw / 10; }
function decodeHumidity(raw) { return raw / 10; }

// 定点数编码（模拟器/PLC 侧写寄存器用）
function encodeTemperature(val) {
    const scaled = Math.round(val * 10);
    return scaled < 0 ? scaled + 65536 : scaled;
}
function encodePressure(val) {
    // 钳位到 uint16：×10 后最多 6553.5kPa，防止异常注入值溢出寄存器
    return Math.min(65535, Math.max(0, Math.round(val * 10)));
}
// 湿度同样钳位：异常注入（>6553.5%）不应写出越界寄存器值
function encodeHumidity(val) {
    return Math.min(65535, Math.max(0, Math.round(val * 10)));
}

/**
 * 解析主包（readHoldingRegisters(2001, 5) 返回的 data 数组）
 * @param {number[]} regs 长度 5 的寄存器数组
 * @returns {{temperature:number, pressure:number, humidity:number,
 *            status:number, seq:number, extended:boolean, subValid:boolean,
 *            anomalyBitmap:number}}
 */
function parseMainPacket(regs) {
    const status = regs[3] || 0;
    const seq = regs[4] || 0;
    return {
        temperature: decodeTemperature(regs[0] || 0),
        pressure: decodePressure(regs[1] || 0),
        humidity: decodeHumidity(regs[2] || 0),
        status,
        seq,
        // 扩展协议判定：bit6 置位，或序号非 0（旧固件 2004/2005 读到全 0）
        extended: (status & STATUS_BITS.extended) !== 0 || seq !== 0,
        subValid: (status & STATUS_BITS.subValid) !== 0,
        anomalyBitmap: status & 0x07 // bit0-2 异常位
    };
}

/**
 * 解析异常子包（readHoldingRegisters(2011, 5) 返回的 data 数组）
 * @param {number[]} regs 长度 5 的寄存器数组
 * @returns {{subSeq:number, bitmap:number,
 *            values:{temperature:number, pressure:number, humidity:number}}}
 */
function parseSubPacket(regs) {
    return {
        subSeq: regs[0] || 0,
        bitmap: (regs[1] || 0) & 0x07,
        values: {
            temperature: decodeTemperature(regs[2] || 0),
            pressure: decodePressure(regs[3] || 0),
            humidity: decodeHumidity(regs[4] || 0)
        }
    };
}

/**
 * 由异常位图 + 子包异常值生成异常列表。
 * 输出与 analyzeFault() 同形 {type, level, value, detail}，
 * 可直接喂给 handleAlarm()。
 * @param {number} bitmap 异常位图（bit0/1/2）
 * @param {{temperature:number, pressure:number, humidity:number}} values 子包数值
 */
function anomaliesFromBitmap(bitmap, values) {
    const anomalies = [];
    if (bitmap & STATUS_BITS.tempAnomaly) {
        const v = values.temperature;
        const high = v > THRESHOLDS.tempHigh;
        anomalies.push({
            type: high ? '高温预警' : '低温预警',
            level: 'warning',
            value: v,
            detail: high
                ? `[PLC判定] 均值温度 ${v}°C > ${THRESHOLDS.tempHigh}°C`
                : `[PLC判定] 均值温度 ${v}°C < ${THRESHOLDS.tempLow}°C`
        });
    }
    if (bitmap & STATUS_BITS.pressAnomaly) {
        const v = values.pressure;
        const high = v > THRESHOLDS.pressHigh;
        anomalies.push({
            type: high ? '高压报警' : '低压报警',
            level: 'error',
            value: v,
            detail: high
                ? `[PLC判定] 均值压力 ${v}kPa > ${THRESHOLDS.pressHigh}kPa`
                : `[PLC判定] 均值压力 ${v}kPa < ${THRESHOLDS.pressLow}kPa`
        });
    }
    if (bitmap & STATUS_BITS.humidAnomaly) {
        const v = values.humidity;
        anomalies.push({
            type: '高湿预警',
            level: 'warning',
            value: v,
            detail: `[PLC判定] 均值湿度 ${v}% > ${THRESHOLDS.humidHigh}%`
        });
    }
    return anomalies;
}

module.exports = {
    THRESHOLDS,
    STATUS_BITS,
    parseMainPacket,
    parseSubPacket,
    anomaliesFromBitmap,
    // 编解码函数供 plc-simulator.js 复用与测试
    encodeTemperature,
    encodePressure,
    encodeHumidity,
    decodeTemperature,
    decodePressure,
    decodeHumidity,
    toSigned16
};
