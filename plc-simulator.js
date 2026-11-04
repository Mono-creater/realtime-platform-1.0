#!/usr/bin/env node
// ============================================================
// 汇川 Easy320 PLC 模拟器（Modbus TCP 从站）
//
// 忠实模拟 Easy320 固件行为：100ms 采样 → 10 条滑窗均值 → 阈值判异常
// → 写主包（2001-2005）→ 异常时写子包（2011-2015）
// → 读回平台写寄存器（2021/2022）按一阶滞后模拟执行机构（闭环）。
//
// 用法：
//   node plc-simulator.js [选项]
//     --host 0.0.0.0           监听地址（默认 0.0.0.0）
//     --port 1502              监听端口（默认 1502，避开真实 PLC 常用 502）
//     --unit 1                 从站号（默认 1）
//     --interval 100           内部采样周期 ms（默认 100）
//     --anomaly temperature:high|low,pressure:high|low,humidity:high
//                              注入异常（作用于原始采样层，完整走均值路径）
//                              'none' 关闭（默认）
//     --base-temp 25 --base-press 250 --base-humid 45   基准值
//     --debug                  打印原始寄存器
//
// 环境变量：PLC_SIM_PORT / PLC_SIM_ANOMALY / PLC_SIM_BASE_TEMP 等同名可替代。
// 协议与寄存器映射见 plc-packet.js 头注释。
// ============================================================

const net = require('net');
const ModbusRTU = require('modbus-serial');
const {
    THRESHOLDS,
    STATUS_BITS,
    encodeTemperature,
    encodePressure,
    encodeHumidity
} = require('./plc-packet');

// ---------- 参数解析 ----------
function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const HOST = arg('--host', process.env.PLC_SIM_HOST || '0.0.0.0');
const PORT = parseInt(arg('--port', process.env.PLC_SIM_PORT || 1502), 10);
const UNIT_ID = parseInt(arg('--unit', process.env.PLC_SIM_UNIT || 1), 10);
const INTERVAL = parseInt(arg('--interval', process.env.PLC_SIM_INTERVAL || 100), 10);
const BASE_TEMP = parseFloat(arg('--base-temp', process.env.PLC_SIM_BASE_TEMP || 25));
const BASE_PRESS = parseFloat(arg('--base-press', process.env.PLC_SIM_BASE_PRESS || 250));
const BASE_HUMID = parseFloat(arg('--base-humid', process.env.PLC_SIM_BASE_HUMID || 45));
const DEBUG = process.argv.includes('--debug');

// 异常注入解析：--anomaly temperature:high,pressure:low （或 none）
const ANOMALY_RAW = arg('--anomaly', process.env.PLC_SIM_ANOMALY || 'none');
const anomalyFlags = { temperature: null, pressure: null, humidity: null }; // null=不注入
if (ANOMALY_RAW && ANOMALY_RAW !== 'none') {
    for (const spec of ANOMALY_RAW.split(',')) {
        const [chan, dir] = spec.trim().split(':');
        if (anomalyFlags[chan] !== undefined && dir) anomalyFlags[chan] = dir;
    }
}

// ---------- 寄存器区 ----------
const REG_MAIN_BASE = 2001;  // 主包：温度/压力/湿度/状态字/序号
const REG_SUB_BASE = 2011;   // 子包：子序号/位图/异常值×3
const REG_WRITE_BASE = 2021; // 平台写回：接触力环输出/姿态环输出

const regs = new Map(); // 协议地址 → uint16
const lastWrite = { time: 0, force: null, height: null };

// ---------- 执行机构一阶滞后模型（与平台 control-engine 植物模型一致） ----------
const TAU_FORCE = 2.0;  // s 气囊压力回路时间常数
const TAU_HEIGHT = 0.5; // s 升弓高度回路时间常数
let pPlant = BASE_PRESS;   // kPa 执行机构当前压力
let hPlant = 1800;         // mm 执行机构当前高度（模拟器内部量，不回写寄存器）

function writeMainPacket(avg, bitmap, hasAnomaly) {
    regs.set(REG_MAIN_BASE + 0, encodeTemperature(avg.temperature));
    regs.set(REG_MAIN_BASE + 1, encodePressure(avg.pressure));
    regs.set(REG_MAIN_BASE + 2, encodeHumidity(avg.humidity));
    // 状态字：bit6 扩展协议标志恒置；bit7 子包有效；bit0-2 异常位
    let status = STATUS_BITS.extended | bitmap;
    if (hasAnomaly) status |= STATUS_BITS.subValid;
    regs.set(REG_MAIN_BASE + 3, status);
    regs.set(REG_MAIN_BASE + 4, packetSeq);
}

function writeSubPacket(avg) {
    regs.set(REG_SUB_BASE + 0, packetSeq);
    regs.set(REG_SUB_BASE + 1, bitmap);
    regs.set(REG_SUB_BASE + 2, encodeTemperature(avg.temperature));
    regs.set(REG_SUB_BASE + 3, encodePressure(avg.pressure));
    regs.set(REG_SUB_BASE + 4, encodeHumidity(avg.humidity));
}

// ---------- 采样与均值 ----------
const WINDOW = 10;
const fifo = { temperature: [], pressure: [], humidity: [] };
let packetSeq = 1;
let bitmap = 0;

function rand(min, max) { return min + Math.random() * (max - min); }

// 生成一路原始采样（异常注入作用于本层，完整走均值与判阈路径）
function sampleChannel(chan, base, noise, inject) {
    if (inject) {
        if (chan === 'temperature') {
            return inject === 'high'
                ? rand(THRESHOLDS.tempHigh + 1, THRESHOLDS.tempHigh + 5)   // 81~85°C
                : rand(THRESHOLDS.tempLow - 3, THRESHOLDS.tempLow - 1);    // -13~-11°C
        }
        if (chan === 'pressure') {
            return inject === 'high'
                ? rand(THRESHOLDS.pressHigh + 20, THRESHOLDS.pressHigh + 80) // 1020~1080kPa
                : rand(THRESHOLDS.pressLow - 20, THRESHOLDS.pressLow - 5);   // 80~95kPa
        }
        if (chan === 'humidity') {
            return rand(THRESHOLDS.humidHigh + 2, THRESHOLDS.humidHigh + 8); // 87~93%
        }
    }
    return base + rand(-noise, noise);
}

function judge(avg) {
    let b = 0;
    if (avg.temperature > THRESHOLDS.tempHigh || avg.temperature < THRESHOLDS.tempLow) b |= STATUS_BITS.tempAnomaly;
    if (avg.pressure > THRESHOLDS.pressHigh || avg.pressure < THRESHOLDS.pressLow) b |= STATUS_BITS.pressAnomaly;
    if (avg.humidity > THRESHOLDS.humidHigh) b |= STATUS_BITS.humidAnomaly;
    return b;
}

// ---------- 内部 tick ----------
let lastLog = 0;
// ST 程序的组包分支是 sampleIdx>=10 才执行（每 1 s 一次）：序号/寄存器只在组包时刻推进。
// 这里按同样的节拍节流，否则 1 s 轮询会看到 seq 每次 +10，被链路监测判成 90% 丢包。
const TICKS_PER_PACKET = Math.max(1, Math.round(1000 / INTERVAL));
let tickSincePacket = 0;

function tick() {
    const now = Date.now();
    const dt = INTERVAL / 1000;

    // 1. 执行机构模型：平台写回的设定值 → 一阶滞后
    const writeFresh = now - lastWrite.time < 10000;
    if (writeFresh && lastWrite.force !== null) {
        const pSet = lastWrite.force / 10; // kPa
        pPlant += ((pSet - pPlant) * dt) / TAU_FORCE;
    } else {
        // 超时无写入：回到基准压力（模拟阀位保持）
        pPlant += ((BASE_PRESS - pPlant) * dt) / TAU_FORCE;
    }
    if (writeFresh && lastWrite.height !== null) {
        hPlant += ((lastWrite.height - hPlant) * dt) / TAU_HEIGHT;
    }
    hPlant = Math.min(2600, Math.max(1000, hPlant));

    // 2. 三路原始采样（压力来自执行机构压力 + 噪声）
    const raw = {
        temperature: sampleChannel('temperature', BASE_TEMP, 1.5, anomalyFlags.temperature),
        pressure: sampleChannel('pressure', pPlant, 8, anomalyFlags.pressure),
        humidity: sampleChannel('humidity', BASE_HUMID, 2.5, anomalyFlags.humidity)
    };

    // 3. 10 条滑窗均值
    const avg = {};
    for (const chan of ['temperature', 'pressure', 'humidity']) {
        fifo[chan].push(raw[chan]);
        if (fifo[chan].length > WINDOW) fifo[chan].shift();
        const sum = fifo[chan].reduce((a, b) => a + b, 0);
        avg[chan] = Math.round((sum / fifo[chan].length) * 100) / 100;
    }
    if (fifo.temperature.length < WINDOW) {
        // 窗口未满：先写当前均值占位，序号不递增（模拟 PLC 上电前 10 个周期）
        writeMainPacket(avg, 0, false);
        return;
    }

    // 未到组包时刻：只更新内部滑窗，不刷新寄存器、不推进序号
    if (++tickSincePacket < TICKS_PER_PACKET) return;
    tickSincePacket = 0;

    // 4. 判阈 → 状态字/位图
    bitmap = judge(avg);
    const hasAnomaly = bitmap !== 0;

    // 5. 序号推进（65535→1 回绕，0 保留给旧固件标识）
    packetSeq = packetSeq >= 65535 ? 1 : packetSeq + 1;

    // 6. 写主包 + 异常子包
    writeMainPacket(avg, bitmap, hasAnomaly);
    if (hasAnomaly) writeSubPacket(avg);

    // 7. 日志（每秒一次）
    if (now - lastLog >= 1000) {
        lastLog = now;
        const status = regs.get(REG_MAIN_BASE + 3);
        console.log(
            `[主包] seq=${packetSeq} 温度=${avg.temperature.toFixed(1)}°C ` +
            `压力=${avg.pressure.toFixed(2)}kPa 湿度=${avg.humidity.toFixed(1)}% ` +
            `状态=0x${status.toString(16).toUpperCase().padStart(2, '0')}` +
            (hasAnomaly ? `  ⚠️ 位图=0b${bitmap.toString(2).padStart(3, '0')} 子包已写入` : '')
        );
        if (writeFresh && lastWrite.force !== null) {
            console.log(`[执行机构] 压力设定=${(lastWrite.force / 10).toFixed(2)}kPa → 当前=${pPlant.toFixed(2)}kPa, 高度设定=${lastWrite.height ?? '-'}mm → 当前=${hPlant.toFixed(0)}mm`);
        }
        if (DEBUG) {
            console.log('[寄存器]', [...regs.entries()].map(([k, v]) => `${k}=${v}`).join(' '));
        }
    }
}

// ---------- Modbus TCP 从站 ----------
const vector = {
    getHoldingRegister(addr, unitID) {
        if (unitID !== UNIT_ID) return 0;
        return regs.get(addr) ?? 0;
    },
    setRegister(addr, value, unitID) {
        if (unitID !== UNIT_ID) return;
        regs.set(addr, value);
        recordWrite(addr, value);
    },
    setRegisterArray(address, values, unitID) {
        if (unitID !== UNIT_ID) return;
        for (let i = 0; i < values.length; i++) {
            regs.set(address + i, values[i]);
            recordWrite(address + i, values[i]);
        }
    }
};

function recordWrite(addr, value) {
    if (addr === REG_WRITE_BASE) {
        lastWrite.force = value;
        lastWrite.time = Date.now();
        console.log(`◀ 收到 FC16 写: ${REG_WRITE_BASE} 接触力环输出=${(value / 10).toFixed(2)}kPa`);
    } else if (addr === REG_WRITE_BASE + 1) {
        lastWrite.height = value;
        lastWrite.time = Date.now();
        console.log(`◀ 收到 FC16 写: ${REG_WRITE_BASE + 1} 姿态环输出=${value}mm`);
    }
}

function printBanner() {
    console.log('============================================');
    console.log('  汇川 Easy320 PLC 模拟器（Modbus TCP 从站）');
    console.log(`  监听: ${HOST}:${PORT}  从站号: ${UNIT_ID}`);
    console.log(`  采样周期: ${INTERVAL}ms  滑窗: ${WINDOW} 条`);
    console.log(`  基准: 温度${BASE_TEMP}°C / 压力${BASE_PRESS}kPa / 湿度${BASE_HUMID}%`);
    console.log(`  异常注入: ${ANOMALY_RAW}`);
    console.log(`  主包: ${REG_MAIN_BASE}-${REG_MAIN_BASE + 4}  子包: ${REG_SUB_BASE}-${REG_SUB_BASE + 4}  写回: ${REG_WRITE_BASE}-${REG_WRITE_BASE + 1}`);
    console.log('  平台 .env 设置: PLC_MODE=real PLC_HOST=127.0.0.1 PLC_PORT=' + PORT);
    console.log('============================================');
    console.log('✓ 已就绪，等待平台连接（Ctrl+C 退出）');
}

function portInUseError() {
    console.error('============================================');
    console.error(`✗ 启动失败：端口 ${PORT} 已被占用（可能已有模拟器实例在运行）`);
    console.error('  处理办法（任选其一）：');
    console.error(`  1) 换端口启动：node plc-simulator.js --port ${PORT + 1}`);
    console.error(`     同时把平台 .env 的 PLC_PORT 改为 ${PORT + 1}`);
    console.error('  2) 清理残留进程：双击 启动PLC模拟器.bat → 选择 2（清理残留模拟器进程）');
    console.error(`  3) 手动查看占用者：netstat -ano | findstr :${PORT}  然后 taskkill /PID <PID> /F`);
    console.error('============================================');
}

// 启动前端口自检：避免“端口被占用却静默不监听”，导致平台连不上却看不出原因
const probe = net.createServer();
probe.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE') { portInUseError(); process.exit(1); }
    console.error(`✗ 监听失败：${err && err.message ? err.message : err}`);
    process.exit(1);
});
probe.once('listening', () => {
    probe.close(() => {
        const server = new ModbusRTU.ServerTCP(vector, { host: HOST, port: PORT, unitID: UNIT_ID });
        if (typeof server.on === 'function') {
            server.on('error', (err) => {
                if (err && err.code === 'EADDRINUSE') { portInUseError(); process.exit(1); }
                console.error(`✗ 模拟器运行错误：${err && err.message ? err.message : err}`);
            });
        }
        printBanner();
        const timer = setInterval(tick, INTERVAL);
        process.on('SIGINT', () => {
            clearInterval(timer);
            server.close(() => {
                console.log('\n模拟器已关闭');
                process.exit(0);
            });
        });
    });
});
probe.listen(PORT, HOST);
