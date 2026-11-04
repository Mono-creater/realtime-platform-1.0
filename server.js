const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const ModbusRTU = require('modbus-serial');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const {
    THRESHOLDS,
    parseMainPacket,
    parseSubPacket,
    anomaliesFromBitmap
} = require('./plc-packet');
const { createControlEngine } = require('./control-engine');
const { seedDemoWarnings, clearDemoWarnings, demoContextFor, stripDemoMark, stripDemoMarkOf, buildDemoWarnings } = require('./demo-warnings');
const security = require('./security');
const healthIndex = require('./health-index');
const createUpgradeRouter = require('./upgrade-routes');
const { createPipeline } = require('./pipeline');
const { createStore } = require('./runtime-store');
const { createSimSource } = require('./sim-source');
const { createClockGuard, createSkewTracker } = require('./clock-guard');
const { createAuth } = require('./auth');
const { createV3Router } = require('./v3-routes');
const pantographArchive = require('./pantograph-archive');

// 自动加载 .env（Node >= 20.19；通过 --env-file 启动时已有变量不会被覆盖）
try { process.loadEnvFile(); } catch { /* 无 .env 文件时忽略 */ }

const sec = security.createSecurity();

// 运行态文件（认证密钥也存这里，保证重启后会话不失效）
const runtimeStore = createStore(
  process.env.RUNTIME_STATE_FILE || path.join(__dirname, 'data', 'runtime-state.json'),
  {
    // 快照目录与保留份数可配（测试时指向临时目录，避免污染 data/）
    snapshotDir: process.env.RUNTIME_SNAPSHOT_DIR || undefined,
    keepSnapshots: Number(process.env.RUNTIME_SNAPSHOT_KEEP) || 7,
  }
);

// 认证与角色（默认关闭；AUTH_ENABLED=true 开启）
let authSecret = runtimeStore.get('authSecret', null);
if (!authSecret) {
  authSecret = require('crypto').randomBytes(32).toString('hex');
  runtimeStore.set('authSecret', authSecret);
}
const auth = createAuth({ secret: authSecret, deviceToken: process.env.API_TOKEN });

const app = express();
app.use(cors(sec.corsOptions()));
app.use(express.json());
app.use(auth.middleware());   // 先认人，再限流/审计
app.use(sec.middleware()); // 写接口令牌校验 + 频率限制 + 操作审计（GET 只读一律放行）

// 登录 / 登出 / 当前用户
auth.routes(app);

// ============================================================
// 托管前端静态文件（Vue 构建产物）
// ============================================================
// 缓存策略：index.html 绝不缓存（前端重新构建后带新 hash 的资源才生效），
// /assets/* 是内容哈希文件名，可长期缓存。
app.use((req, res, next) => {
  if (req.method === 'GET') {
    if (req.path === '/' || req.path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (req.path.startsWith('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
  next();
});
app.use(express.static(path.join(__dirname, 'dist')));

// ============================================================
// 根路径响应（返回 index.html）
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const server = http.createServer(app);

// Socket.IO 的跨域策略（此前硬编码 origin:"*"，CORS_ORIGIN 只对 REST 生效）：
//   · 未配置 CORS_ORIGIN：不设 CORS 头，浏览器同源连接即可（Vite 代理 / 生产同源托管都走同源）；
//   · 配置了 CORS_ORIGIN：按其白名单放行，并在握手阶段校验 Origin ——
//     浏览器发起 WebSocket 握手不受 CORS 约束，只靠 cors 选项挡不住跨站连接。
const socketAllowedOrigins = String(process.env.CORS_ORIGIN || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ioOptions = {};
if (socketAllowedOrigins.length) {
  ioOptions.cors = { origin: socketAllowedOrigins, methods: ['GET', 'POST'] };
  ioOptions.allowRequest = (req, callback) => {
    const origin = req.headers.origin;
    // 无 Origin 为服务端客户端（脚本/探针），放行；有 Origin 必须命中白名单
    const ok = !origin || socketAllowedOrigins.includes(origin);
    callback(ok ? null : 'origin not allowed', ok);
  };
}
const io = new Server(server, ioOptions);

// ============================================================
// 检查是否为模拟模式
// ============================================================
// 运行时模式标志（运行中可能因 PLC 断连自动回退到模拟模式）
let SIMULATION_MODE = process.env.PLC_MODE === 'simulation';

/**
 * 真实 PLC 连不上时是否允许自动回退到模拟数据。
 *
 * 演示环境需要它（双击就能看界面），但**生产环境必须关闭**：
 * 否则界面照常出数，运维看到的却是模拟值，属于最危险的一类"静默失真"。
 * 默认：NODE_ENV=production 时关闭，其余环境开启；可用 ALLOW_SIM_FALLBACK 显式覆盖。
 */
const ALLOW_SIM_FALLBACK = String(
  process.env.ALLOW_SIM_FALLBACK !== undefined
    ? process.env.ALLOW_SIM_FALLBACK
    : (process.env.NODE_ENV === 'production' ? 'false' : 'true')
).toLowerCase() !== 'false';


// 条件加载 Prisma：只要配置了 DATABASE_URL 就连接，
// 与"当前数据源是 PLC 还是模拟器"解耦 —— 模拟模式下同样需要读取历史告警、
// 写入整定数据集（sensor_sample），否则 Z-N 辨识永远无数据可拟合。
let prisma = null;
const HAS_DB_URL = Boolean(process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim());
if (HAS_DB_URL) {
  try {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
    console.log('✅ Prisma Client 已初始化');
  } catch (err) {
    console.warn('⚠️ Prisma 加载失败，将以无数据库模式运行:', err.message);
  }
} else {
  console.log('🔄 未配置 DATABASE_URL，以无数据库模式运行（告警与工单驻留内存）');
}

// ============================================================
// 运行态：v2 判据/运维引擎单例（runtimeStore 已在文件顶部创建）
//   采集链路 → pipeline.ingest()；/api/v2/* 读同一实例；
//   工单/告警编号与链路累计量跨重启延续（data/runtime-state.json）。
// ============================================================
const pipeline = createPipeline({
  autoCreateOrder: String(process.env.AUTO_CREATE_ORDER || 'true').toLowerCase() !== 'false',
  orderCooldownMs: (Number(process.env.ORDER_COOLDOWN_MIN) || 10) * 60000,
  rulWindowMin: Number(process.env.RUL_WINDOW_MIN) || 10,
});
if (pipeline.restore(runtimeStore.get('pipeline'))) {
  console.log(`✅ 运行态已恢复：工单 ${pipeline.maint.orders.length} 条、EWMA 告警 ${pipeline.alarms.alarms.length} 条`);
}
pipeline.onChange = () => runtimeStore.set('pipeline', pipeline.serialize());

// ============================================================
// 时钟健康：平台侧与 NTP 比对；上报侧统计 clientTime 偏差
//   用途：避免"告警时间"与"车端事件时间"对不上却无人察觉（见 clock-guard.js 头注释）
// ============================================================
const clockGuard = createClockGuard();
const skewTracker = createSkewTracker();
clockGuard.start();

// ============================================================
// 1. 原有业务逻辑（告警管理）
// ============================================================
// 2026-08-27 起清除内置模拟数据（原 6 条 2024 演示记录及饼图/统计初值）：
// 告警历史从空开始，真实数据由 PLC 告警或数据库加载（loadHistoryFromDB）提供。
//
// 现按需重建那 6 条演示告警：见 demo-warnings.js。
// 由 .env 的 SEED_DEMO_WARNINGS 控制（默认 true，即启动时补齐 6 条演示数据）；
// 接入真实 PLC 采集做正式实验时置为 false，即可回到"仅真实数据"的干净状态。
// 演示数据备注均带 [演示数据] 标记，可据此一键清理而不误伤真实记录。
const SEED_DEMO_WARNINGS = String(process.env.SEED_DEMO_WARNINGS || 'true').toLowerCase() === 'true';
let currentWarningList = [];

let currentOverLimit = [
  { title: '压力超限', count: 0 },
  { title: '导高超限', count: 0 },
  { title: '燃弧超限', count: 0 },
  { title: '拉出值超限', count: 0 },
  // 3.0：碳滑板自身告警（以前只有弓网关系，滑板只有健康分）
  { title: '磨耗到限预警', count: 0 },
  { title: '偏磨超限', count: 0 },
  { title: '裂纹检出', count: 0 },
  { title: '电弧烧蚀', count: 0 },
];

/**
 * 对外输出的告警列表（HTTP / WebSocket 共用）。
 * 统一在此剥除 [演示数据] 标记：库内与内存列表必须保留该标记
 * （seedDemoWarnings 幂等判重、clearDemoWarnings 精确清理、demoContextFor 合并上下文都依赖它），
 * 仅在响应给前端时去掉，避免备注列出现"[演示数据]"前缀。
 */
/**
 * 对外输出的告警列表（HTTP / WebSocket 共用）。
 * 统一在此剥除 [演示数据] 标记：库内与内存列表必须保留该标记
 * （seedDemoWarnings 幂等判重、clearDemoWarnings 精确清理、demoContextFor 合并上下文都依赖它），
 * 仅在响应给前端时去掉，避免备注列出现"[演示数据]"前缀。
 * 并附带受电弓档案上下文（3.0：告警不只报"通道超限"，还报"是哪架受电弓、装多久、跑多少、滑板是否快到限"）。
 */
function enrichWarning(warning) {
    const w = stripDemoMarkOf(warning);
    try {
        const pg = pantographArchive.resolveForWarning(warning);
        if (pg) return { ...w, pantographId: pg.id, context: pg.context };
    } catch { /* 绑定失败不阻断告警输出 */ }
    return w;
}

function clientWarningList() {
  return (currentWarningList || []).map(enrichWarning);
}

/** 告警列表版本号：客户端据此判断是否需要重新拉全量 */
let warningVersion = 0;

/**
 * 全量快照：仅在连接首帧、批量删除、清理等低频场景发送。
 */
function broadcastFullUpdate() {
  warningVersion += 1;
  io.emit('fullUpdate', {
    type: 'full',
    version: warningVersion,
    warningList: clientWarningList(),
    overLimit: currentOverLimit || [],
  });
}

/**
 * 增量广播：只发变化的记录与删除的 id。
 * 500 条告警全量序列化约 100 KB，而单条变更通常只有 1~2 条 —— 高频路径必须走增量。
 * 字段：type='delta'、upserts（新增/更新）、removed（删除的 id）、version。
 */
function broadcastWarningChange(upserts = [], removed = []) {
  if (!upserts.length && !removed.length) return;
  warningVersion += 1;
  io.emit('fullUpdate', {
    type: 'delta',
    version: warningVersion,
    upserts: upserts.map(enrichWarning),
    removed,
    overLimit: currentOverLimit || [],
  });
}

// ============================================================
// 内存告警列表公共操作（封顶 + 统计 + 唯一 ID）
// ============================================================
const MAX_MEMORY_WARNINGS = 500;

function updateOverLimitStats() {
  const counts = {};
  currentWarningList.forEach(w => { counts[w.content] = (counts[w.content] || 0) + 1; });
  currentOverLimit = currentOverLimit.map(card => ({
    ...card,
    count: counts[card.title] || 0,
  }));
}

function pushWarning(warning) {
  currentWarningList.push(warning);
  if (currentWarningList.length > MAX_MEMORY_WARNINGS) {
    currentWarningList.splice(0, currentWarningList.length - MAX_MEMORY_WARNINGS);
  }
}

let memIdCounter = Date.now();
function nextMemId() { return ++memIdCounter; }

async function loadHistoryFromDB() {
  if (!prisma) {
    console.log('ℹ️ 无数据库模式：告警历史仅驻留内存');
    return;
  }
  try {
    const history = await prisma.warningHistory.findMany({
      orderBy: { time: 'desc' },
      take: MAX_MEMORY_WARNINGS,
    });
    if (history.length > 0) {
      currentWarningList = history.map(item => ({
        id: item.id,
        code: item.code,
        content: item.content,
        time: item.time.toISOString().slice(0,10),
        timeFull: item.time.toISOString(),
        worker: item.worker || '',
        remark: item.remark || '/',
      }));
    } else {
      console.log('ℹ️ 数据库为空，告警历史从空开始');
    }
    updateOverLimitStats();
    console.log(`✅ 当前加载 ${currentWarningList.length} 条记录`);
  } catch (err) {
    console.error('❌ 加载历史数据失败，使用内存默认数据:', err);
  }
}

// ---------- 环境类预警口径（温度/湿度） ----------
// 高温/低温/高湿由环境因素引起，不反映碳滑板自身状态：
// 1. 不计入碳滑板健康度扣分（/api/stats/summary 与前端 MonitorGlobal 保持同一口径）
// 2. 在故障总览与 PDF 报告的备注中写明具体成因，便于与环境预警和设备故障区分
const ENV_WARNING_CONTENTS = ['高温预警', '低温预警', '高湿预警'];
const ENV_WARNING_CAUSES = {
    '高温预警': '环境温度过高所致，属环境因素，非碳滑板部件故障；建议检查环境散热与空调',
    '低温预警': '环境温度过低所致，属环境因素，非碳滑板部件故障；低温下碳条变脆，建议关注取流状态',
    '高湿预警': '环境湿度过高所致，属环境因素，非碳滑板部件故障；高湿易加剧燃弧，建议加强除湿通风',
    // 压力类告警同样给出成因说明：否则会落入调试 JSON 分支，
    // 备注长度超过数据库列宽导致入库失败
    '高压报警': '气囊压力高于上限，可能因比例阀卡滞、气源压力偏高或压力传感器漂移；建议核查气路与阀件',
    '低压报警': '气囊压力低于下限，可能因气路泄漏、气源压力不足或升弓机构卡阻；建议检查气密性与供气'
};
// 备注取值：环境类预警的历史数据可能是空、'/' 或 JSON 调试串，统一兜底为成因说明
function resolveEnvRemark(content, remark) {
    if (!ENV_WARNING_CONTENTS.includes(content)) return remark || '/';
    if (!remark || remark === '/' || remark.startsWith('{')) {
        return ENV_WARNING_CAUSES[content];
    }
    return remark;
}

// ---------- 落库口径 ----------
// 环境类预警（高温/低温/高湿）不入库，只推前端：它们只反映气候与环境，不反映设备状态；
// 环境量的真正用途是作为 PID 三参数整定的过程数据，写入 sensor_sample 表。
const PERSIST_ENV_WARNINGS = String(process.env.PERSIST_ENV_WARNINGS || 'false').toLowerCase() === 'true';
const PERSIST_SAMPLES = String(process.env.PERSIST_SAMPLES || 'true').toLowerCase() !== 'false';
const SAMPLE_INTERVAL_MS = Math.max(1000, Number(process.env.SAMPLE_INTERVAL_S || 10) * 1000);

// 采样写库：按 SAMPLE_INTERVAL_MS 节流 + 批量落库，采集主流程不因写库阻塞
let lastSampleAt = 0;
let sampleQueue = [];
let sampleFlushing = false;
let samplePersisted = 0;

function collectSample(avg, seq) {
    if (!PERSIST_SAMPLES || !prisma) return;
    const now = Date.now();
    if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
    lastSampleAt = now;
    let loops = {};
    try { loops = (controlEngine.getStatus() || {}).loops || {}; } catch { /* 控制器未就绪 */ }
    sampleQueue.push({
        time: new Date(now),
        temperature: avg.temperature,
        pressure: avg.pressure,
        humidity: avg.humidity,
        contactForce: loops.force ? loops.force.measurement : null,
        height: loops.posture ? loops.posture.measurement : null,
        outputForce: loops.force ? loops.force.output : null,
        outputHeight: loops.posture ? loops.posture.output : null,
        seq: seq == null ? null : seq
    });
    flushSamples();
}

async function flushSamples() {
    if (!prisma || sampleFlushing || sampleQueue.length === 0) return;
    sampleFlushing = true;
    const batch = sampleQueue.splice(0, 200);
    try {
        await prisma.sensorSample.createMany({ data: batch });
        samplePersisted += batch.length;
    } catch (err) {
        console.warn('⚠️ 采样落库失败（不影响实时采集）:', err.message);
    } finally {
        sampleFlushing = false;
    }
}

async function saveWarningToHistory(warning) {
  if (!prisma) {
    console.log('💾 无数据库模式：保存警告到内存（不持久化）', warning.content);
    return { id: nextMemId() };
  }
  // 模拟器数据不落库：只推前端/内存，避免演示数据污染真实告警历史与健康度
  if (warning.code === 'SIM_SENSOR') {
    return { id: nextMemId(), persisted: false, reason: '模拟数据不入库' };
  }
  // 环境因素引起的预警（高温/低温/高湿）不落库：这类量只用于 PID 整定的过程数据，
  // 其预警值随时间与气候变化，入库会淹没有价值的设备告警。仅推送前端与内存列表。
  if (!PERSIST_ENV_WARNINGS && ENV_WARNING_CONTENTS.includes(warning.content)) {
    return { id: nextMemId(), persisted: false, reason: '环境类预警按配置不入库' };
  }
  // 兜底截断：即使数据库列被建成较短的 VARCHAR，也不因单条备注过长而丢掉整条告警
  const REMARK_MAX = Number(process.env.WARNING_REMARK_MAX || 2000);
  const remark = warning.remark == null ? null : String(warning.remark).slice(0, REMARK_MAX);
  const created = await prisma.warningHistory.create({
    data: {
      code: warning.code,
      content: warning.content,
      time: new Date(warning.time),
      worker: warning.worker,
      remark,
    },
  });
  return created;
}

// ---------- WebSocket 事件 ----------
/**
 * 传感器通道的投递方式：
 *   subscribe（默认）—— 只有显式订阅 'sensor' 的连接才收 sensorData（当前仅环境参数页需要）；
 *   broadcast         —— 退回旧行为（广播给所有连接），用于灰度回滚或排查订阅问题。
 * 切换：WS_SENSOR_MODE=broadcast
 */
const WS_SENSOR_MODE = String(process.env.WS_SENSOR_MODE || 'subscribe').toLowerCase() === 'broadcast'
  ? 'broadcast' : 'subscribe';
const SENSOR_CHANNEL = 'sensor';
/** 允许订阅的通道白名单（避免任意字符串成为房间名） */
const WS_CHANNELS = new Set([SENSOR_CHANNEL]);

io.on('connection', (socket) => {
  socket.emit('fullUpdate', {
    type: 'full',
    version: warningVersion,
    // 必须走 clientWarningList()：连接建立时的首帧推送同样不能带 [演示数据] 标记，
    // 否则会覆盖前端先由 /api/history 取得的干净数据（备注列又会冒出标记）。
    warningList: clientWarningList(),
    overLimit: currentOverLimit,
  });

  // 订阅/退订（幂等）：参数为通道名数组，非法值忽略
  socket.on('subscribe', (channels, ack) => {
    const list = Array.isArray(channels) ? channels : [];
    const joined = [];
    for (const ch of list) {
      if (!WS_CHANNELS.has(ch)) continue;
      socket.join(ch);
      joined.push(ch);
    }
    if (typeof ack === 'function') ack({ ok: true, joined, mode: WS_SENSOR_MODE });
  });

  socket.on('unsubscribe', (channels) => {
    const list = Array.isArray(channels) ? channels : [];
    for (const ch of list) {
      if (!WS_CHANNELS.has(ch)) continue;
      socket.leave(ch);
    }
  });

  // 说明：addWarning / updatePie 两个客户端上行事件已废弃（见 src/stores/alarms.js）。
  // 现在写操作统一走 REST（/api/alert 等），WS 只负责下行推送与订阅管理。
});

/** 当前各通道的订阅者数量（供 /api/health 观测投递面） */
function wsStats() {
  const all = io.sockets.sockets.size;
  const sensor = io.sockets.adapter.rooms.get(SENSOR_CHANNEL);
  return { mode: WS_SENSOR_MODE, clients: all, sensorSubscribers: sensor ? sensor.size : 0 };
}

// ---------- HTTP API ----------
const DAY_MS = 86400000;
/** 本地时区当日 0 点（offsetDays 可为负） */
function startOfLocalDay(offsetDays = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  return d;
}
/** 本地日键 YYYY-MM-DD（统计分桶统一口径，避免 UTC 日切把 0~8 点的告警算到前一天） */
function localDayKey(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 系统自动写入的工号：不计入"人工处理率" */
const AUTO_WORKERS = new Set(['PLC_AUTO', 'SIM_AUTO', 'SYSTEM', '']);

app.get('/api/test', async (req, res) => {
  if (!prisma) {
    return res.json({ count: currentWarningList.length, persisted: false });
  }
  try {
    const count = await prisma.warningHistory.count();
    res.json({ count, persisted: true });
  } catch (err) {
    res.status(500).json({ error: `数据库不可用: ${err.message}` });
  }
});

// 平台自身健康状态（供运维探针 / 反向代理健康检查）
app.get('/api/health', (req, res) => {
  const now = Date.now();
  const ls = pipeline.link.stats(now);
  res.json({
    ok: true,
    version: require('./package.json').version,
    uptimeSec: Math.round(process.uptime()),
    mode: SIMULATION_MODE ? 'simulation' : 'real',
    fallbackAllowed: ALLOW_SIM_FALLBACK,
    plc: {
      connected: Boolean(plcClient),
      host: PLC_CONFIG.host,
      port: PLC_CONFIG.port,
      retryInMs: Math.max(0, plcRetryAt - now),
    },
    db: { configured: HAS_DB_URL, clientLoaded: Boolean(prisma) },
    pipeline: {
      ingested: pipeline.ingested,
      quality: ls.quality,
      alarms: pipeline.alarms.alarms.length,
      orders: pipeline.maint.orders.length,
    },
    memory: {
      warnings: currentWarningList.length,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
    },
    ws: wsStats(),
    clock: clockGuard.status(),
    clockSkew: skewTracker.stats(),
    auth: auth.status(),
    runtime: runtimeStore.stats(),
  });
});

// 最近传感器帧（页面打开时回填趋势图，见 sensorRecent 注释）
app.get('/api/sensor/recent', (req, res) => {
    res.json({ success: true, count: sensorRecent.length, list: sensorRecent });
});

// 时钟明细（?check=1 强制立即校时一次）
app.get('/api/clock', async (req, res) => {
  const force = req.query.check === '1' || req.query.check === 'true';
  const st = force ? await clockGuard.check({ force: true }) : clockGuard.status();
  res.json({ clock: st, skew: skewTracker.stats() });
});

app.get('/api/stats/summary', async (req, res) => {
  try {
    // 碳滑板健康度：统一口径见 health-index.js（滚动窗口 + 部件告警加权，环境/气路类不扣减）
    const windowDays = parseInt(process.env.HEALTH_WINDOW_DAYS) || healthIndex.DEFAULT_WINDOW_DAYS;
    const cutoff = new Date(Date.now() - windowDays * DAY_MS);
    const dayStart = startOfLocalDay(0);
    let todayCount;
    let healthList;
    if (prisma) {
      todayCount = await prisma.warningHistory.count({ where: { time: { gte: dayStart } } });
      // 取窗口内的告警用于健康度计算（content/time/worker/code 四列足够）
      healthList = await prisma.warningHistory.findMany({
        where: { time: { gte: cutoff } },
        select: { content: true, time: true, worker: true, code: true },
      });
    } else {
      healthList = currentWarningList;
      const todayKey = localDayKey(Date.now());
      todayCount = currentWarningList.filter(item => localDayKey(item.timeFull || item.time) === todayKey).length;
    }
    const healthInfo = healthIndex.computeHealth(healthList, { windowDays });

    // 在线设备：近 24 h 有数据上报的【列车】去重数。
    // 修复：原先按碳滑板编号（THBxxxxxx）去重，同一列车多块滑板会被算成多台设备，
    // 演示数据下得到 7 台，而车队在册只有 6 架 —— 数字对不上。
    const since24 = Date.now() - DAY_MS;
    const codes = new Set();
    let handled = 0;
    for (const w of healthList) {
      const t = new Date(w.timeFull || w.time).getTime();
      if (Number.isFinite(t) && t >= since24) {
        const train = pantographArchive.trainOfWarning(w);
        if (train) codes.add('TRAIN-' + train);
        else if (w.code) codes.add(String(w.code));
      }
      if (w.worker && !AUTO_WORKERS.has(String(w.worker))) handled += 1;
    }
    // 处理率：人工登记工号的告警占比（原为写死的 94）
    const handleRate = healthList.length ? Math.round((handled / healthList.length) * 100) : 0;

    // 链路侧指标：供总览页"运行状态"条直接展示（论文式3 质量码 / 数据完整率）
    const ls = pipeline.link.stats(Date.now());
    const dataCompleteness = ls.expected > 0
      ? Math.min(1, (ls.packets - ls.gaps) / Math.max(ls.expected, 1))
      : 0;

    res.json({
      onlineVehicles: codes.size,
      onlineDevices: codes.size,
      todayAlarms: todayCount,
      handleRate,
      windowDays,
      health: healthInfo.score,
      healthDetail: healthInfo,
      linkQuality: ls.quality,
      dataCompleteness: +dataCompleteness.toFixed(4),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats/trend', async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
  const startDate = startOfLocalDay(-(days - 1));

  // 统一按【本地时区】分桶：SQL 的 DATE(time) 按 UTC 切日，会把 0~8 点的告警算到前一天
  const buckets = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    buckets.set(localDayKey(d), 0);
  }

  try {
    let rows;
    if (prisma) {
      rows = await prisma.warningHistory.findMany({
        where: { time: { gte: startDate } },
        select: { time: true },
        take: 50000,
      });
    } else {
      rows = currentWarningList.map((w) => ({ time: w.timeFull || w.time }));
    }
    for (const r of rows) {
      const key = localDayKey(r.time);
      if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
    }
    const dates = [...buckets.keys()].map((k) => k.slice(5));
    const counts = [...buckets.values()];
    res.json({ dates, counts, startDate: localDayKey(startDate), days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats/distribution', async (req, res) => {
  if (!prisma) {
    const counts = {};
    currentWarningList.forEach(item => {
      counts[item.content] = (counts[item.content] || 0) + 1;
    });
    const data = Object.keys(counts).map(name => ({ name, value: counts[name] }));
    return res.json(data);
  }
  try {
    const results = await prisma.$queryRaw`
      SELECT content, COUNT(*) as count
      FROM warning_history
      GROUP BY content
    `;
    const data = results.map(r => ({ name: r.content, value: Number(r.count) }));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', async (req, res) => {
  const { start, end, content } = req.query;
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 2000) : 500;
  const where = {};
  if (content) where.content = content;
  if (start || end) {
    where.time = {};
    if (start) where.time.gte = new Date(start);
    if (end) where.time.lte = new Date(end);
  }

  if (!prisma) {
    let list = [...currentWarningList];
    if (content) list = list.filter(item => item.content === content);
    if (start) list = list.filter(item => item.time >= start);
    if (end) list = list.filter(item => item.time <= end);
    list.sort((a, b) => new Date(b.time) - new Date(a.time));
    // 对外剥除 [演示数据] 标记（库内/内存列表保留原样）+ 附受电弓档案上下文
    return res.json(list.slice(0, limit).map(enrichWarning));
  }

  try {
    const history = await prisma.warningHistory.findMany({
      where,
      orderBy: { time: 'desc' },
      take: limit,
    });
    res.json(history.map(enrichWarning));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 告警运行上下文（车号/线路/区站/公里标/速度） ----------
// warning_history 为精简口径（5 个业务字段），上下文此前只留内存，重启即丢，
// 导致真实告警详情页区站/公里标全为 "--"。这里把上下文写入运行态文件，
// 与告警 id 一一对应，详情页读取时合并（不新增数据库表）。
const CONTEXT_LIMIT = 1000;
function saveWarningContext(id, ctx) {
  if (id === undefined || id === null || !ctx) return;
  const all = runtimeStore.get('contexts', {}) || {};
  all[id] = Object.assign({ at: Date.now() }, ctx);
  const keys = Object.keys(all);
  if (keys.length > CONTEXT_LIMIT) {
    keys.sort((a, b) => Number(a) - Number(b))
      .slice(0, keys.length - CONTEXT_LIMIT)
      .forEach((k) => { delete all[k]; });
  }
  runtimeStore.set('contexts', all);
}
function getWarningContext(id) {
  const all = runtimeStore.get('contexts', {}) || {};
  return all[id] || null;
}

app.post('/api/alert', async (req, res) => {
  try {
    const {
      timestamp, alarmType, level, value, code, worker,
      carNumber, line, station, direction, location, mileage, speed,
      imageUrl, videoUrl,
      // 时钟对齐（可选）：车端/边缘盒上报自身时间与授时来源
      clientTime, t0Utc, t0Edge, eventId, clock: clockMeta
    } = req.body;

    const parsedTime = timestamp ? new Date(timestamp) : new Date();
    const time = isNaN(parsedTime.getTime()) ? new Date() : parsedTime;

    // 上报端时间偏差：只做统计与标记，不改变告警时间（平台侧仍以服务器时钟为准）
    let clockInfo = null;
    const reportedRaw = clientTime || t0Utc;
    if (reportedRaw) {
      const reported = Date.parse(reportedRaw);
      if (Number.isFinite(reported)) {
        const skewMs = reported - Date.now();
        const degraded = Math.abs(skewMs) > clockGuard.threshold();
        skewTracker.push({
          skewMs,
          code: code || 'UNKNOWN',
          source: (clockMeta && clockMeta.source) || 'client',
        });
        if (degraded) skewTracker.markDegraded();
        clockInfo = {
          skewMs: Math.round(skewMs),
          degraded,
          timeQuality: degraded ? 'degraded' : 'good',
          source: (clockMeta && clockMeta.source) || 'client',
          uncertaintyMs: clockMeta && Number.isFinite(Number(clockMeta.uncertaintyMs))
            ? Number(clockMeta.uncertaintyMs) : null,
        };
      }
    }

    // WarningHistory 模型只持久化 code/content/time/worker/remark 五个业务字段，
    // 其余为上报上下文，仅保留在内存/广播中供前端展示。
    // 注意：不可把上下文字段一并传给 prisma.create()，未知参数会抛
    // "Unknown argument" 并使整个写接口返回 500。
    const data = {
      code: code || 'UNKNOWN',
      content: alarmType || '未知告警',
      time,
      worker: worker || 'SYSTEM',
      // 环境类预警备注写明具体成因，其余告警仍记录图片地址
      remark: ENV_WARNING_CAUSES[alarmType] || (imageUrl || '')
    };

    const created = await saveWarningToHistory(data);

    const newWarning = {
      id: created.id,
      code: data.code,
      content: data.content,
      time: data.time.toISOString().slice(0, 10),
      // 完整时刻：供表格"时间"列展示，time 字段按天口径供趋势/统计使用
      timeFull: data.time.toISOString(),
      worker: data.worker,
      remark: created.persisted === false
        ? resolveEnvRemark(data.content, data.remark)
        : (data.remark || '/'),
      level: level || '--',
      value: value || 0,
      carNumber: carNumber || '--',
      line: line || '--',
      station: station || '--',
      direction: direction || '--',
      location: location || '--',
      mileage: mileage || '--',
      speed: speed || 0,
      imageUrl: imageUrl || '',
      videoUrl: videoUrl || ''
    };

    pushWarning(newWarning);
    // 上下文随告警落运行态文件：重启后详情页仍能显示车号/区站/公里标
    const hasCtx = [carNumber, line, station, direction, location, mileage, speed]
      .some(v => v !== undefined && v !== null && v !== '') || Boolean(clockInfo) || Boolean(eventId);
    if (hasCtx) {
      saveWarningContext(created.id, Object.assign({
        timeFull: data.time.toISOString(),
        carNumber, line, station, direction, location, mileage, speed,
      }, eventId ? { eventId } : {},
      clockInfo ? { timeQuality: clockInfo.timeQuality, skewMs: clockInfo.skewMs } : {}));
    }
    updateOverLimitStats();
    broadcastWarningChange([newWarning]);
    res.json({ success: true, id: created.id, persisted: created.persisted !== false, clock: clockInfo });
  } catch (err) {
    console.error('告警接收失败:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 告警详情补齐运行上下文（车号/线路/区站/行别/定位点号/公里标/速度）。
 * warning_history 为精简口径，这些上下文随上报报文流动、不入库；
 * 演示记录（remark 带 [演示数据] 标记）按编号从 demo-warnings.js 取定义合并，
 * 并把"发现时间"补成完整本地时刻，使详情页信息完整可读。
 * 真实记录不受影响（demoContextFor 返回 null，time 维持按天口径）。
 */
function localDateTime(d) {
  const t = new Date(d);
  if (isNaN(t.getTime())) return String(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ` +
         `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

function withDemoContext(warning) {
  if (!warning) return warning;
  // 先按库内原始备注判定是否演示记录（demoContextFor 依赖 [演示数据] 标记），再剥标记
  const base = stripDemoMarkOf(warning);
  const demo = demoContextFor(warning);
  // 真实告警：从运行态文件补上下文（/api/alert 上报时保存）
  const saved = demo ? null : getWarningContext(warning.id);
  const ctx = demo || saved;

  const full = (saved && saved.timeFull) || warning.timeFull || warning.time;
  const formatted = String(full || '').length > 10 ? localDateTime(full) : base.time;

  if (!ctx) return Object.assign({}, base, { time: formatted });

  const fields = {};
  for (const k of ['carNumber', 'line', 'station', 'direction', 'location', 'mileage', 'speed',
    'eventId', 'timeQuality', 'skewMs']) {
    if (ctx[k] !== undefined && ctx[k] !== null && ctx[k] !== '') fields[k] = ctx[k];
  }
  return Object.assign({}, base, fields, { time: localDateTime((saved && saved.timeFull) || full) });
}

app.get('/api/warning/:id', async (req, res) => {
  const { id } = req.params;
  const numericId = Number(id);
  if (isNaN(numericId)) {
    return res.status(400).json({ error: '无效的ID' });
  }

  if (!prisma) {
    const warning = currentWarningList.find(w => w.id === numericId);
    if (!warning) {
      return res.status(404).json({ error: '记录不存在' });
    }
    return res.json(withDemoContext(warning));
  }

  try {
    const warning = await prisma.warningHistory.findUnique({
      where: { id: numericId }
    });
    if (!warning) {
      return res.status(404).json({ error: '记录不存在' });
    }
    const result = {
      ...warning,
      time: warning.time.toISOString().slice(0, 10),
      // 完整时刻：详情页"发现时间"须显示到秒，缺此字段会被按 UTC 零点解析成 08:00:00
      timeFull: warning.time.toISOString(),
      createdAt: warning.createdAt.toISOString()
    };
    res.json(withDemoContext(result));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/warning/:id', async (req, res) => {
  const { id } = req.params;
  const numericId = Number(id);
  if (isNaN(numericId)) {
    return res.status(400).json({ error: '无效的 ID' });
  }

  try {
    console.log(`🔍 尝试删除 ID: ${numericId}`);

    const index = currentWarningList.findIndex(w => Number(w.id) === numericId);
    if (index !== -1) {
      currentWarningList.splice(index, 1);
      console.log(`✅ 内存移除成功，剩余 ${currentWarningList.length} 条`);
    } else {
      console.warn(`⚠️ 内存中未找到 ID ${numericId}`);
    }

    if (prisma) {
      try {
        await prisma.warningHistory.delete({
          where: { id: numericId },
        });
        console.log(`✅ 数据库删除成功, ID: ${numericId}`);
      } catch (dbErr) {
        if (dbErr.code === 'P2025') {
          console.log(`ℹ️ 数据库中不存在 ID ${numericId}，跳过数据库删除`);
        } else {
          throw dbErr;
        }
      }
    }

    updateOverLimitStats();
    broadcastWarningChange([], [numericId]);

    res.json({ success: true, message: '记录已删除' });
  } catch (err) {
    console.error('❌ 删除失败详情:', err);
    console.error(err.stack);
    res.status(500).json({ error: err.message || '删除失败，请查看后端日志' });
  }
});

// 批量删除故障记录（故障总览勾选删除）
app.delete('/api/warnings', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids 必须是非空数组' });
  }
  const numericIds = [...new Set(ids.map(Number).filter(n => Number.isFinite(n)))];
  if (numericIds.length === 0) {
    return res.status(400).json({ error: 'ids 中没有有效数字' });
  }

  // 内存列表同步删除（无数据库模式下的数据源）
  const idSet = new Set(numericIds);
  const before = currentWarningList.length;
  currentWarningList = currentWarningList.filter(w => !idSet.has(Number(w.id)));
  const deletedMem = before - currentWarningList.length;

  // 数据库删除（deleteMany 对不存在的记录不报错）
  let deletedDb = 0;
  if (prisma) {
    try {
      const result = await prisma.warningHistory.deleteMany({
        where: { id: { in: numericIds } },
      });
      deletedDb = result.count;
    } catch (dbErr) {
      console.error('❌ 批量删除数据库记录失败:', dbErr.message);
      return res.status(500).json({ error: dbErr.message });
    }
  }

  updateOverLimitStats();
  broadcastWarningChange([], numericIds);
  const deleted = prisma ? deletedDb : deletedMem;
  console.log(`🗑️ 批量删除故障记录: ${deleted} 条 (请求 ${numericIds.length} 条)`);
  res.json({ deleted, ids: numericIds });
});

// ============================================================
// 2. 文件上传模块
// ============================================================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log(`📁 已创建上传目录: ${uploadDir}`);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const filename = `${uuidv4()}${ext}`;
        cb(null, filename);
    }
});

const upload = multer({
    storage,
    limits: sec.uploadLimits(),
    fileFilter: sec.uploadFilter() // 扩展名白名单，阻断 .html/.js/.svg 等可执行载荷
});

app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            const tooLarge = err.code === 'LIMIT_FILE_SIZE';
            return res.status(tooLarge ? 413 : 400).json({
                error: tooLarge ? '文件超出大小上限' : err.message
            });
        }
        if (!req.file) {
            return res.status(400).json({ error: '未上传文件' });
        }
        res.json({ url: `/uploads/${req.file.filename}` });
    });
});

// ============================================================
// PDF 导出：导出指定故障报告
// ============================================================
const PDFDocument = require('pdfkit');
const PDF_FONT_PATH = path.join(__dirname, 'src', 'assets', 'fonts', 'FZYTJW.TTF');

function formatPdfTime(t) {
    if (typeof t !== 'string') return '--';
    const d = new Date(t);
    return isNaN(d.getTime()) ? t : d.toLocaleString('zh-CN', { hour12: false });
}

app.get('/api/export/pdf/:id', async (req, res) => {
    const numericId = Number(req.params.id);
    if (isNaN(numericId)) {
        return res.status(400).json({ error: '无效的ID' });
    }

    // 查找故障记录（内存或数据库）
    let warning;
    if (prisma) {
        try {
            warning = await prisma.warningHistory.findUnique({ where: { id: numericId } });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
        if (warning) {
            warning = {
                ...warning,
                time: warning.time.toISOString().slice(0, 10),
                timeFull: warning.time.toISOString(),
            };
        }
    } else {
        warning = currentWarningList.find(w => Number(w.id) === numericId);
    }
    if (!warning) {
        return res.status(404).json({ error: '记录不存在' });
    }

    try {
        const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 50, right: 50 } });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="fault-${numericId}.pdf"`);
        doc.registerFont('FZYTJW', PDF_FONT_PATH);
        doc.pipe(res);

        // 标题栏
        doc.rect(0, 0, doc.page.width, 90).fill('#0a2e5d');
        doc.font('FZYTJW').fontSize(24).fillColor('#ffffff')
            .text('故障报告', 0, 30, { align: 'center' });
        doc.fontSize(10)
            .text(`生成时间：${new Date().toLocaleString('zh-CN')}`, 0, 62, { align: 'center' });

        // 字段列表（基础字段 + 相机告警扩展字段）
        const fields = [
            ['故障编号', warning.code],
            ['故障类型', warning.content],
            ['预警时间', formatPdfTime(warning.timeFull || warning.time)],
            ['维修工号', warning.worker],
            ...(warning.level ? [['告警级别', warning.level]] : []),
            ...(warning.value !== undefined && warning.value !== null ? [['数值', String(warning.value)]] : []),
            ...(warning.carNumber ? [['车号', warning.carNumber]] : []),
            ...(warning.line ? [['线路', warning.line]] : []),
            ...(warning.station ? [['车站', warning.station]] : []),
            ...(warning.direction ? [['方向', warning.direction]] : []),
            ...(warning.location ? [['位置', warning.location]] : []),
            ...(warning.mileage ? [['里程', warning.mileage]] : []),
            ...(warning.speed !== undefined && warning.speed !== null ? [['速度', String(warning.speed)]] : []),
            ['备注', resolveEnvRemark(warning.content, stripDemoMark(warning.remark))],
        ];

        let y = 130;
        for (const [label, value] of fields) {
            doc.font('FZYTJW').fontSize(11).fillColor('#0a2e5d')
                .text(label, 60, y, { width: 100 });
            doc.fillColor('#333333')
                .text(String(value ?? '--'), 180, y, { width: 370 });
            y += 28;
            doc.moveTo(60, y - 8).lineTo(doc.page.width - 60, y - 8)
                .lineWidth(0.5).strokeColor('#c9d8ea').stroke();
        }

        doc.end();
    } catch (err) {
        console.error('❌ PDF 生成失败:', err);
        res.status(500).json({ error: 'PDF 生成失败' });
    }
});

// ============================================================
// 2.5 黑盒子（图传）告警上传 + 前端 HTTP 轮询
//     链路：黑盒子 → POST multipart → 本平台 → 前端 GET 轮询（纯 HTTP，不走 WebSocket）
//     来源：F:/realtime-platform1.1/图传 原型，按当前主干改造后并入
// ============================================================
const boxAlarmDir = path.resolve(process.env.BOX_ALARM_DIR || path.join(uploadDir, 'box-alarm'));
const boxAlarmJsonPath = path.resolve(process.env.BOX_ALARM_JSON || path.join(uploadDir, 'box-alarms.json'));
const BOX_ALARM_PERSIST = String(process.env.BOX_ALARM_PERSIST || 'true').toLowerCase() !== 'false';
const MAX_BOX_ALARMS = Number(process.env.BOX_ALARM_MAX) || 1000;

fs.mkdirSync(boxAlarmDir, { recursive: true });

let boxAlarmList = [];
if (BOX_ALARM_PERSIST) {
  try {
    if (fs.existsSync(boxAlarmJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(boxAlarmJsonPath, 'utf8'));
      if (Array.isArray(parsed)) boxAlarmList = parsed;
      console.log(`📂 已加载黑盒子历史告警 ${boxAlarmList.length} 条`);
    }
  } catch (err) {
    console.warn('⚠️ 黑盒子告警 JSON 读取失败，从空列表开始:', err.message);
    boxAlarmList = [];
  }
}

// 写入：去抖 + 临时文件原子替换（原型的同步直写遇到断电会截断整个文件）
let boxAlarmId = boxAlarmList.reduce((m, r) => Math.max(m, Number(r.id) || 0), Date.now() - 1);
let boxPersistTimer = null;
let boxPersistPending = false;
function persistBoxAlarms(immediate = false) {
  if (!BOX_ALARM_PERSIST) return;
  boxPersistPending = true;
  const write = () => {
    boxPersistTimer = null;
    if (!boxPersistPending) return;
    boxPersistPending = false;
    try {
      fs.mkdirSync(path.dirname(boxAlarmJsonPath), { recursive: true });
      const tmp = `${boxAlarmJsonPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(boxAlarmList));
      fs.renameSync(tmp, boxAlarmJsonPath);
    } catch (err) {
      console.warn('⚠️ 黑盒子告警 JSON 写入失败（不影响响应）:', err.message);
    }
  };
  if (immediate) {
    if (boxPersistTimer) { clearTimeout(boxPersistTimer); boxPersistTimer = null; }
    write();
    return;
  }
  if (boxPersistTimer) return;
  boxPersistTimer = setTimeout(write, 500);
  if (boxPersistTimer.unref) boxPersistTimer.unref();
}

const boxStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, boxAlarmDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '')
      || (String(file.mimetype).startsWith('video/') ? '.mp4' : '.jpg');
    cb(null, `${Date.now()}-${uuidv4()}${ext.toLowerCase()}`);
  },
});
const boxAlarmUpload = multer({
  storage: boxStorage,
  limits: sec.uploadLimits(),
  fileFilter: sec.uploadFilter(),   // 与平台一致：扩展名白名单
});

/**
 * POST /api/speedtest —— 4G/5G 上行测速（只读流计数，不落盘、不入库）
 * 客户端 POST application/octet-stream 任意字节，服务端只计数并回读，用于实测
 * 「边缘盒 → 平台」真实上行带宽（判断视频切片能否边跑边传、实时预览能否开）。
 * 认证：与写接口一致，开启 AUTH 后需 X-API-Token。
 */
app.post('/api/speedtest', (req, res) => {
  let received = 0;
  req.on('data', (c) => { received += c.length; });
  req.on('error', (err) => res.status(500).json({ success: false, error: err.message }));
  req.on('end', () => res.json({ success: true, bytes: received }));
});

/**
 * POST /api/upload-alarm
 * multipart 字段：
 *   文件 image（抓拍图，必填）、video（短视频，可选）
 *   文本 timestamp / carNumber / faultType / eventId（用于幂等去重）/ 其余键值对 → sensorData
 * 认证：开启 AUTH 后需携带 X-API-Token（设备令牌），浏览器登录态不适用于黑盒子
 */
app.post('/api/upload-alarm', (req, res) => {
  boxAlarmUpload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'video', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) {
      const tooLarge = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        success: false,
        error: tooLarge ? '文件超出大小上限' : err.message,
      });
    }

    const body = req.body || {};
    const imageFile = req.files && req.files.image && req.files.image[0];
    const videoFile = req.files && req.files.video && req.files.video[0];
    if (!imageFile && !videoFile) {
      return res.status(400).json({ success: false, error: '至少需要上传 image 或 video 之一' });
    }

    // 幂等：同一 eventId 重复上传直接返回原记录（黑盒子弱网重传很常见）
    const eventId = String(body.eventId || body.event_id || body.uuid || '').trim();
    if (eventId) {
      const dup = boxAlarmList.find((r) => r.eventId === eventId);
      if (dup) {
        return res.json({
          success: true, duplicated: true, id: dup.id,
          imageUrl: dup.imageUrl, videoUrl: dup.videoUrl,
        });
      }
    }

    const parsedTime = (body.timestamp || body.time) ? new Date(body.timestamp || body.time) : new Date();
    const time = isNaN(parsedTime.getTime()) ? new Date() : parsedTime;

    const KNOWN_KEYS = new Set(['timestamp', 'time', 'carNumber', 'car_number',
      'vehicle', 'faultType', 'fault_type', 'alarmType', 'eventId', 'event_id', 'uuid',
      'camera', 'cam', 'position']);
    const sensorData = {};
    for (const [k, v] of Object.entries(body)) {
      if (!KNOWN_KEYS.has(k)) sensorData[k] = v;
    }

    const record = {
      id: ++boxAlarmId,
      eventId: eventId || null,
      time: time.toISOString(),
      carNumber: body.carNumber || body.car_number || body.vehicle || '--',
      faultType: body.faultType || body.fault_type || body.alarmType || '未知故障',
      camera: body.camera || body.cam || body.position || '',
      sensorData,
      imageUrl: imageFile ? `/uploads/box-alarm/${imageFile.filename}` : '',
      videoUrl: videoFile ? `/uploads/box-alarm/${videoFile.filename}` : '',
      receivedAt: new Date().toISOString(),
    };

    boxAlarmList.push(record);
    if (boxAlarmList.length > MAX_BOX_ALARMS) {
      boxAlarmList.splice(0, boxAlarmList.length - MAX_BOX_ALARMS);
    }
    persistBoxAlarms();
    console.log(`📥 [黑盒子] #${record.id} 车号=${record.carNumber} 弓位=${record.camera || '--'} 类型=${record.faultType} 图=${record.imageUrl || '无'} 视频=${record.videoUrl || '无'}`);
    res.json({ success: true, id: record.id, imageUrl: record.imageUrl, videoUrl: record.videoUrl });
  });
});

/** GET /api/get-alarm-list?sinceId=（前端 300 ms 轮询；GET 只读，鉴权中间件按只读规则处理） */
app.get('/api/get-alarm-list', (req, res) => {
  let list = boxAlarmList;
  const sinceId = Number(req.query.sinceId);
  if (Number.isFinite(sinceId) && sinceId > 0) {
    list = list.filter((r) => Number(r.id) > sinceId);
  }
  res.json({ success: true, count: list.length, list });
});

// 自定义媒体目录时也要能静态访问（默认在 uploads 下，由下面的 /uploads 统一托管）
if (path.resolve(boxAlarmDir) !== path.resolve(path.join(uploadDir, 'box-alarm'))) {
  app.use('/uploads/box-alarm', express.static(boxAlarmDir));
}

app.use('/uploads', express.static(uploadDir));

// ============================================================
// 3. 数据采集模块（支持真实PLC和模拟模式）
// ============================================================
const PLC_CONFIG = {
    host: process.env.PLC_HOST || '192.168.1.88',
    port: parseInt(process.env.PLC_PORT) || 502,
    unitId: parseInt(process.env.PLC_UNIT_ID) || 1,
    registers: {
        temperature: parseInt(process.env.PLC_REG_TEMP) || 2001,
        pressure: parseInt(process.env.PLC_REG_PRESS) || 2002,
        humidity: parseInt(process.env.PLC_REG_HUMID) || 2003,
        status: parseInt(process.env.PLC_REG_STATUS) || 2004,
        seq: parseInt(process.env.PLC_REG_SEQ) || 2005,
        subBase: parseInt(process.env.PLC_REG_SUB_BASE) || 2011,
        writeForce: parseInt(process.env.PLC_REG_WRITE_FORCE) || 2021,
        writeHeight: parseInt(process.env.PLC_REG_WRITE_HEIGHT) || 2022
    },
    readInterval: parseInt(process.env.PLC_INTERVAL) || 2000,
    windowSize: parseInt(process.env.PLC_WINDOW) || 10
};

let plcClient = null;
let sensorBuffer = [];
let isPLCConnecting = false;
let realInterval = null;
let simulationInterval = null;
let isSimulationPaused = false;

// PLC 重连退避（失败后 2s 起步，翻倍至 30s 封顶）
const PLC_RECONNECT_INITIAL_MS = 2000;
const PLC_RECONNECT_MAX_MS = 30000;
let plcReconnectDelay = PLC_RECONNECT_INITIAL_MS;
let plcRetryAt = 0;

// ---------- 故障分析逻辑（阈值单一来源：plc-packet.js THRESHOLDS） ----------
function analyzeFault(data) {
    const faults = [];
    if (data.temperature > THRESHOLDS.tempHigh) {
        faults.push({
            type: '高温预警',
            level: 'warning',
            value: data.temperature,
            detail: `均值温度 ${data.temperature}°C > ${THRESHOLDS.tempHigh}°C`
        });
    } else if (data.temperature < THRESHOLDS.tempLow) {
        faults.push({
            type: '低温预警',
            level: 'warning',
            value: data.temperature,
            detail: `均值温度 ${data.temperature}°C < ${THRESHOLDS.tempLow}°C`
        });
    }
    if (data.pressure > THRESHOLDS.pressHigh) {
        faults.push({
            type: '高压报警',
            level: 'error',
            value: data.pressure,
            detail: `均值压力 ${data.pressure}kPa > ${THRESHOLDS.pressHigh}kPa`
        });
    } else if (data.pressure < THRESHOLDS.pressLow) {
        faults.push({
            type: '低压报警',
            level: 'error',
            value: data.pressure,
            detail: `均值压力 ${data.pressure}kPa < ${THRESHOLDS.pressLow}kPa`
        });
    }
    if (data.humidity > THRESHOLDS.humidHigh) {
        faults.push({
            type: '高湿预警',
            level: 'warning',
            value: data.humidity,
            detail: `均值湿度 ${data.humidity}% > ${THRESHOLDS.humidHigh}%`
        });
    }
    return faults;
}

// 最近 50 帧传感器数据的内存环：页面任何时候打开都能回填历史趋势，
// 解决"不打开页面图表就不跑"的观感问题（服务端采集本身一直在跑）
const SENSOR_RECENT_MAX = 50;
const sensorRecent = [];

function broadcastSensorData(avg, faults, extra = {}) {
    const payload = {
        timestamp: new Date().toISOString(),
        temperature: avg.temperature,
        pressure: avg.pressure,
        humidity: avg.humidity,
        faults: faults,
        type: faults.length > 0 ? 'alarm' : 'normal',
        // 扩展字段：数据源 / 异常子包 / 原始报文 / 控制状态
        source: extra.source || 'simulation',
        anomalies: extra.anomalies || faults,
        packet: extra.packet || null,
        control: extra.control || (controlEngine ? controlEngine.getStatus() : null)
    };
    // 同时缓存双环测量值：控制台打开时即可回填收敛曲线，而不是从空白开始
    const ctl = payload.control && payload.control.computed;
    sensorRecent.push({
        t: payload.timestamp,
        temperature: avg.temperature,
        pressure: avg.pressure,
        humidity: avg.humidity,
        contactForce: ctl ? ctl.contactForce : null,
        height: ctl ? ctl.height : null,
    });
    if (sensorRecent.length > SENSOR_RECENT_MAX) sensorRecent.shift();
    // 按订阅投递：只有声明订阅 sensor 的页面（当前是环境参数页）才收，避免其它页面白收 674 B/2 s
    if (WS_SENSOR_MODE === 'broadcast') io.emit('sensorData', payload);
    else io.to(SENSOR_CHANNEL).emit('sensorData', payload);
    return payload;
}

// 告警去重：同类型 10s 内且数值变化 <5% 不重复入库（防 2s 轮询刷屏）
const lastAlarmAt = {};

/**
 * 把一条采样喂给 v2 判据流水线（EWMA 趋势检测 / 链路序号 / RUL / 自适应周期）。
 * 采集主流程不因流水线异常中断：任何错误只记日志。
 */
function ingestPipeline(sample) {
    try {
        const out = pipeline.ingest(sample);
        if (out && (out.alarms.length || out.orders.length)) {
            io.emit('v2Update', {
                alarms: out.alarms,
                orders: out.orders,
                stats: pipeline.alarms.stats(),
            });
            for (const a of out.alarms) {
                console.log(`📈 [EWMA] ${a.signal} ${a.level}（${a.source === 'roc' ? '变化率通道' : '阈值通道'}，值 ${a.value}，roc ${a.roc}）`);
            }
            for (const o of out.orders) console.log(`🧾 自动建单 ${o.id}（${o.deviceId} / ${o.level}）`);
        }
        return out;
    } catch (err) {
        console.warn('⚠️ v2 判据流水线异常（不影响采集）:', err.message);
        return null;
    }
}

async function handleAlarm(faults, avg, opts = {}) {
    const code = opts.code || 'PLC_SENSOR';
    const added = [];
    for (const fault of faults) {
        const dedupeKey = `${code}|${fault.type}`;
        const prev = lastAlarmAt[dedupeKey];
        const value = Number(fault.value) || 0;
        if (prev && Date.now() - prev.time < 10000
            && Math.abs(prev.value - value) <= Math.max(5, Math.abs(prev.value) * 0.05)) {
            continue; // 重复告警，跳过
        }
        lastAlarmAt[dedupeKey] = { time: Date.now(), value: value };
        const warning = {
            code,
            content: fault.type,
            time: new Date().toISOString(),
            worker: 'PLC_AUTO',
            // 环境类预警备注写明具体成因（含触发数据），其余类型保留调试 JSON
            remark: ENV_WARNING_CAUSES[fault.type]
                ? `${ENV_WARNING_CAUSES[fault.type]}；触发数据：${fault.detail}`
                : JSON.stringify({
                    avg: avg,
                    faults: faults,
                    timestamp: new Date().toISOString()
                })
        };
        const created = await saveWarningToHistory(warning);
        const memWarning = {
            id: created.id,
            code: warning.code,
            content: warning.content,
            time: warning.time,
            timeFull: new Date(warning.time).toISOString(),
            worker: warning.worker,
            remark: warning.remark
        };
        pushWarning(memWarning);
        added.push(memWarning);
    }

    updateOverLimitStats();
    broadcastWarningChange(added);
}

// ---------- Modbus 请求互斥锁（FC03 读 / FC16 写串行化） ----------
let modbusChain = Promise.resolve();
function modbusEnqueue(fn) {
    const p = modbusChain.then(fn, fn);
    modbusChain = p.catch(() => {});
    return p;
}

// ---------- 控制引擎（双环 PID + Z-N 整定） ----------
const controlEngine = createControlEngine();
let latestSensor = null;        // 最近一次传感器均值（喂给控制引擎）
let lastPacket = null;          // 最近一次原始报文（/api/plc/packet 调试用）
let controlLoopInterval = null;
let lastWrittenForce = null;    // 写回去重
let lastWrittenHeight = null;
let lastWriteAt = 0;            // 最近写回时间：输出不变时每 5s 保活重写（ZN 整定期间输出恒定，防止 PLC 侧写回看门狗/模拟器漂移）

function startControlLoop() {
    if (controlLoopInterval) return;
    controlLoopInterval = setInterval(() => {
        const mode = SIMULATION_MODE ? 'simulation' : 'plc';
        controlEngine.tick(latestSensor, mode);

        // 写回：自动调节或整定中的回路，输出变化时 FC16 写 2021/2022；
        // 输出不变则每 5s 保活重写一次（整定阶跃期间输出恒定，防止 PLC 侧看门狗判超时）
        if (!SIMULATION_MODE && plcClient) {
            const st = controlEngine.getStatus();
            const tuning = st.tune && st.tune.state === 'sampling';
            const forceActive = st.loops.force.auto || (tuning && st.tune.loop === 'force');
            const postureActive = st.loops.posture.auto || (tuning && st.tune.loop === 'posture');
            const forceRaw = Math.round(Math.min(1000, Math.max(50, st.loops.force.output)) * 10); // 压力寄存器 ×10（1000kPa→10000，uint16 安全）
            const heightRaw = Math.round(Math.min(2600, Math.max(1000, st.loops.posture.output)));
            const anyActive = forceActive || postureActive;
            const forceChanged = forceRaw !== lastWrittenForce;
            const heightChanged = heightRaw !== lastWrittenHeight;
            const keepAlive = anyActive && Date.now() - lastWriteAt > 5000;
            if (anyActive && (forceChanged || heightChanged || keepAlive)) {
                if (forceChanged) lastWrittenForce = forceRaw;
                if (heightChanged) lastWrittenHeight = heightRaw;
                lastWriteAt = Date.now();
                modbusEnqueue(() => plcClient.writeRegisters(
                    PLC_CONFIG.registers.writeForce, [forceRaw, heightRaw]))
                    .catch((err) => console.error('⚠️ 写回 PLC 失败（不影响采集）:', err.message));
            }
        }
    }, controlEngine.config.controlInterval);
}

// ---------- 真实PLC采集 ----------
async function connectPLC() {
    if (isPLCConnecting) return null;
    isPLCConnecting = true;
    try {
        const client = new ModbusRTU();
        await client.connectTCP(PLC_CONFIG.host, { port: PLC_CONFIG.port });
        client.setID(PLC_CONFIG.unitId);
        console.log(`✅ 汇川 Easy320 PLC 连接成功 (${PLC_CONFIG.host}:${PLC_CONFIG.port})`);
        isPLCConnecting = false;
        return client;
    } catch (err) {
        console.error(`❌ 汇川 Easy320 PLC 连接失败 (${err.message})`);
        isPLCConnecting = false;
        return null;
    }
}

async function readAndBufferSensorData() {
    if (!plcClient) {
        if (Date.now() < plcRetryAt) return; // 退避等待中，跳过本次重连
        plcClient = await connectPLC();
        if (!plcClient) {
            plcReconnectDelay = Math.min(plcReconnectDelay * 2, PLC_RECONNECT_MAX_MS);
            plcRetryAt = Date.now() + plcReconnectDelay;
            console.warn(`⚠️ PLC 连接失败，${(plcReconnectDelay / 1000).toFixed(0)}s 后重试`);
            return;
        }
    }

    try {
        // 主包：2001-2005（地址连续，一次批量读取）
        const regs = await modbusEnqueue(() =>
            plcClient.readHoldingRegisters(PLC_CONFIG.registers.temperature, 5)
                .then((r) => r.data));
        const packet = parseMainPacket(regs);
        plcReconnectDelay = PLC_RECONNECT_INITIAL_MS; // 读取成功，重置退避

        if (packet.extended) {
            // ===== 新固件扩展协议：直接用 PLC 侧 10 条均值，不再二次平均 =====
            const avg = {
                temperature: Math.round(packet.temperature * 10) / 10,
                pressure: Math.round(packet.pressure * 100) / 100,
                humidity: Math.round(packet.humidity * 10) / 10
            };
            latestSensor = avg;
            collectSample(avg, packet.seq); // 环境量+双环状态写入整定数据集（节流）
            ingestPipeline({ t: Date.now(), ...avg, seq: packet.seq, deviceId: 'PLC-01' });

            let sub = null;
            let faults = [];
            if (packet.subValid) {
                const subRegs = await modbusEnqueue(() =>
                    plcClient.readHoldingRegisters(PLC_CONFIG.registers.subBase, 5)
                        .then((r) => r.data));
                sub = parseSubPacket(subRegs);
                faults = anomaliesFromBitmap(sub.bitmap || packet.anomalyBitmap, sub.values);
            } else if (packet.anomalyBitmap) {
                faults = anomaliesFromBitmap(packet.anomalyBitmap, {
                    temperature: packet.temperature,
                    pressure: packet.pressure,
                    humidity: packet.humidity
                });
            }
            lastPacket = { source: 'plc', main: packet, sub, receivedAt: Date.now() };
            broadcastSensorData(avg, faults, {
                source: 'plc', anomalies: faults, packet: lastPacket
            });
            if (faults.length > 0) {
                await handleAlarm(faults, avg);
                console.log(`🚨 [PLC] seq=${packet.seq} 检测到 ${faults.length} 个异常（子包序号=${sub ? sub.subSeq : '-'}）`);
            }
        } else {
            // ===== 旧固件回退：平台侧 10 条缓冲均值 =====
            const record = {
                timestamp: Date.now(),
                temperature: Math.round(packet.temperature * 10) / 10,
                pressure: Math.round(packet.pressure * 100) / 100,
                humidity: Math.round(packet.humidity * 10) / 10
            };
            sensorBuffer.push(record);
            collectSample(record, packet.seq); // 旧固件回退路径同样写入整定数据集
            if (sensorBuffer.length >= PLC_CONFIG.windowSize) {
                await processBuffer();
            }
        }
    } catch (err) {
        console.error('❌ 读取传感器数据失败:', err.message);
        plcClient = null;
        plcReconnectDelay = Math.min(plcReconnectDelay * 2, PLC_RECONNECT_MAX_MS);
        plcRetryAt = Date.now() + plcReconnectDelay;
    }
}

async function processBuffer() {
    if (sensorBuffer.length === 0) return;
    const sum = sensorBuffer.reduce((acc, cur) => {
        acc.temp += cur.temperature;
        acc.press += cur.pressure;
        acc.humid += cur.humidity;
        return acc;
    }, { temp: 0, press: 0, humid: 0 });
    const count = sensorBuffer.length;
    const avg = {
        temperature: Math.round((sum.temp / count) * 10) / 10,
        pressure: Math.round((sum.press / count) * 100) / 100,
        humidity: Math.round((sum.humid / count) * 10) / 10
    };
    latestSensor = avg;
    // 旧固件无序号（seq 传 null）：链路统计将其排除，仅参与告警判据
    ingestPipeline({ t: Date.now(), ...avg, seq: null, deviceId: 'PLC-01' });
    const faults = analyzeFault(avg);
    broadcastSensorData(avg, faults, { source: 'fallback' });
    if (faults.length > 0) {
        await handleAlarm(faults, avg);
        console.log(`🚨 [旧固件回退] 检测到 ${faults.length} 个故障`);
    }
    sensorBuffer = [];
}

// ---------- 模拟数据源 ----------
// 具体信号生成见 sim-source.js：稳态随机游走 + 稀发线性缓变（论文表10 的 2~10 ℃/min 量级）。
// 原实现每 2 s 独立取随机数、30% 概率直接越限，1.5 min 可产生 30+ 条告警并污染健康度。
const simSource = createSimSource({ intervalMs: PLC_CONFIG.readInterval });

function nextSimSample() {
    const out = simSource.next();
    if (out.episode && out.episode.phase === 'rise' && simSource.state.episode && simSource.state.episode.ticks === 1) {
        console.log(`🌱 [模拟] 注入缓变工况：${out.episode.sig}（斜率见 sim-source.js，用于演示 EWMA 趋势判据）`);
    }
    return out;
}

function startSimulation() {
    if (simulationInterval) return;
    if (realInterval) {
        clearInterval(realInterval);
        realInterval = null;
    }
    console.log('🔄 模拟模式已启动（稳态游走 + 稀发缓变注入）');
    simulationInterval = setInterval(() => {
        if (isSimulationPaused) return;
        const { avg, seq } = nextSimSample();
        latestSensor = avg;
        collectSample(avg, seq);                       // 模拟模式同样产出整定数据集
        ingestPipeline({ t: Date.now(), ...avg, seq, deviceId: 'SIM-01' });

        const faults = analyzeFault(avg);
        broadcastSensorData(avg, faults, { source: 'simulation' });
        if (faults.length > 0) {
            handleAlarm(faults, avg, { code: 'SIM_SENSOR' }).catch(console.error);
            console.log(`🚨 [模拟] 检测到 ${faults.length} 个故障`);
        }
    }, PLC_CONFIG.readInterval);
}

async function startRealCollection() {
    if (simulationInterval) {
        clearInterval(simulationInterval);
        simulationInterval = null;
    }
    isSimulationPaused = false;
    plcClient = await connectPLC();
    if (plcClient) {
        SIMULATION_MODE = false;
        realInterval = setInterval(readAndBufferSensorData, PLC_CONFIG.readInterval);
        setTimeout(readAndBufferSensorData, 500);
        console.log('✅ 切换到真实PLC模式');
    } else {
        if (ALLOW_SIM_FALLBACK) {
            console.warn('⚠️ 真实PLC连接失败，自动切换到模拟模式');
            SIMULATION_MODE = true;
            startSimulation();
        } else {
            // 生产口径：宁可报告"链路坏"，也不拿模拟数据顶替
            SIMULATION_MODE = false;
            console.error('⛔ 真实 PLC 连接失败，且已禁用模拟回退（ALLOW_SIM_FALLBACK=false）');
            console.error('   平台保持真实模式：链路质量置为 BAD，采集循环按退避策略持续重连。');
            pipeline.link.onError();
            if (!realInterval) realInterval = setInterval(readAndBufferSensorData, PLC_CONFIG.readInterval);
        }
    }
}

// ---------- API：查询和切换模式 ----------
app.get('/api/plc/mode', (req, res) => {
    res.json({
        mode: SIMULATION_MODE ? 'simulation' : 'real',
        connected: Boolean(plcClient),
        fallbackAllowed: ALLOW_SIM_FALLBACK,
        retryInMs: Math.max(0, plcRetryAt - Date.now()),
    });
});

app.post('/api/plc/mode', async (req, res) => {
    const { mode } = req.body;
    if (mode !== 'simulation' && mode !== 'real') {
        return res.status(400).json({ error: '模式必须是 simulation 或 real' });
    }
    if ((mode === 'simulation' && SIMULATION_MODE) || (mode === 'real' && !SIMULATION_MODE)) {
        return res.json({ mode: mode, message: '已经是该模式' });
    }

    if (mode === 'simulation') {
        SIMULATION_MODE = true;
        if (realInterval) {
            clearInterval(realInterval);
            realInterval = null;
        }
        plcClient = null;
        sensorBuffer = [];
        startSimulation();
    } else {
        SIMULATION_MODE = false;
        if (simulationInterval) {
            clearInterval(simulationInterval);
            simulationInterval = null;
        }
        plcClient = null;
        sensorBuffer = [];
        await startRealCollection();
    }
    // 回包用【实际生效】的模式：PLC 连接失败时 startRealCollection 会自动回退到模拟，
    // 若仍按请求值返回 'real'，前端按钮会显示"真实模式"而服务端实际在跑模拟数据。
    const actual = SIMULATION_MODE ? 'simulation' : 'real';
    const connected = Boolean(plcClient);
    let message;
    if (actual !== mode) {
        message = 'PLC 连接失败，已回退到模拟模式（请检查 .env 的 PLC_HOST/PLC_PORT 与 PLC 模拟器）';
    } else if (mode === 'real' && !connected) {
        message = '已切换到真实模式，但 PLC 未连接；平台将按退避策略重连，期间数据质量码为 BAD';
    } else {
        message = `已切换到 ${mode} 模式`;
    }
    res.json({
        mode: actual,
        requested: mode,
        connected,
        fallbackAllowed: ALLOW_SIM_FALLBACK,
        message,
    });
});

app.get('/api/simulation/pause', (req, res) => {
    res.json({ paused: isSimulationPaused });
});

// 手工注入一次缓变工况（演示/联调用）：模拟器默认是稀发注入，现场演示不想等时用这个
app.post('/api/simulation/inject', (req, res) => {
    const sig = (req.body || {}).sig || 'temperature';
    if (!['temperature', 'pressure', 'humidity'].includes(sig)) {
        return res.status(400).json({ error: 'sig 必须是 temperature / pressure / humidity' });
    }
    const rate = simSource.inject(sig);
    console.log(`🌱 手工注入缓变工况：${sig} ${rate.toFixed(1)}/min`);
    res.json({
        ok: true, sig, ratePerMin: +rate.toFixed(2),
        message: '已注入线性缓变工况，约 90~180 s 后可观察到 EWMA 变化率告警',
    });
});

app.post('/api/simulation/pause', (req, res) => {
    const body = req.body;
    if (body && typeof body.paused === 'boolean') {
        isSimulationPaused = body.paused;
    } else {
        isSimulationPaused = !isSimulationPaused; // 兼容旧调用：无 body 时切换
    }
    console.log(`⏸️ 模拟数据${isSimulationPaused ? '已暂停' : '已恢复'}`);
    res.json({ paused: isSimulationPaused });
});

// ---------- API：PLC 报文与控制引擎 ----------
app.get('/api/plc/packet', (req, res) => {
    res.json(lastPacket || { source: 'plc', main: null, sub: null, receivedAt: null });
});

app.get('/api/control/status', (req, res) => {
    res.json(controlEngine.getStatus());
});

app.post('/api/control/params', (req, res) => {
    const { loop, kp, ki, kd, target } = req.body || {};
    if (loop !== 'force' && loop !== 'posture') {
        return res.status(400).json({ error: 'loop 必须是 force 或 posture' });
    }
    const r = controlEngine.setParams(loop, { kp, ki, kd, target });
    if (!r.ok) return res.status(400).json({ error: r.error });
    console.log(`🎛️ PID 参数已更新 [${loop}]`, { kp, ki, kd, target });
    res.json({ ok: true, status: controlEngine.getStatus() });
});

app.post('/api/control/auto', (req, res) => {
    const { loop, enabled } = req.body || {};
    if (loop !== 'force' && loop !== 'posture') {
        return res.status(400).json({ error: 'loop 必须是 force 或 posture' });
    }
    const r = controlEngine.setAuto(loop, enabled !== false);
    if (!r.ok) return res.status(400).json({ error: r.error });
    console.log(`🤖 自动调节 [${loop}] ${enabled !== false ? '开启' : '关闭'}`);
    res.json({ ok: true, status: controlEngine.getStatus() });
});

app.post('/api/control/tune', (req, res) => {
    const { loop } = req.body || {};
    const r = controlEngine.startTune(loop);
    if (!r.ok) return res.status(400).json({ error: r.error });
    console.log(`📈 Z-N 阶跃整定已开始 [${loop}]，阶跃 Δu=${r.stepDelta}`);
    res.json({ ok: true, stepDelta: r.stepDelta, status: controlEngine.getStatus() });
});

app.post('/api/control/tune/cancel', (req, res) => {
    const r = controlEngine.cancelTune();
    if (!r.ok) return res.status(400).json({ error: r.error });
    console.log('🛑 Z-N 整定已取消');
    res.json({ ok: true, status: controlEngine.getStatus() });
});

// ============================================================
// 4. 清除模拟数据 API
// ============================================================
app.delete('/api/simulation/clear', async (req, res) => {
    try {
        // 模拟告警统一使用 SIM_SENSOR 编号；历史遗留的 PLC_SENSOR 在模拟模式下同样视为模拟数据
        const simCodes = SIMULATION_MODE ? ['SIM_SENSOR', 'PLC_SENSOR'] : ['SIM_SENSOR'];
        const before = currentWarningList.length;
        currentWarningList = currentWarningList.filter(w => !simCodes.includes(w.code));
        const removed = before - currentWarningList.length;

        // 同步清理数据库（此前只清内存，重启后记录会"复活"）
        let dbRemoved = 0;
        if (prisma) {
            try {
                const r = await prisma.warningHistory.deleteMany({ where: { code: { in: simCodes } } });
                dbRemoved = r.count;
            } catch (e) {
                console.warn('⚠️ 清理模拟告警（数据库）失败:', e.message);
            }
        }

        updateOverLimitStats();
        broadcastFullUpdate();
        console.log(`🧹 已清除模拟告警：内存 ${removed} 条 / 数据库 ${dbRemoved} 条`);
        res.json({ success: true, memRemoved: removed, dbRemoved });
    } catch (err) {
        console.error('❌ 清除模拟数据失败:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 4.5 v2 升级能力挂载（标准/告警引擎/链路监测/工单/健康/KPI）+ 安全审计
// ============================================================
app.get('/api/v2/audit', sec.auditHandler());
app.get('/api/v2/security', (req, res) => res.json(sec.status()));

// ---- 整定数据集：环境量与双环过程量（Z-N 辨识 K/T/L → 计算 Kp/Ki/Kd 三参数） ----
app.get('/api/v2/samples', async (req, res) => {
    if (!prisma) return res.json({ persisted: false, count: 0, list: [], note: '当前为无数据库模式，采样只存在于内存' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 5000);
    const where = {};
    if (req.query.since) {
        const d = new Date(req.query.since);
        if (!isNaN(d.getTime())) where.time = { gte: d };
    }
    try {
        const list = await prisma.sensorSample.findMany({ where, orderBy: { time: 'desc' }, take: limit });
        res.json({
            persisted: true, count: list.length, totalPersisted: samplePersisted,
            intervalS: SAMPLE_INTERVAL_MS / 1000, sampleEnabled: PERSIST_SAMPLES, list
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/v2/tuning-dataset', async (req, res) => {
    const loop = req.query.loop === 'posture' ? 'posture' : 'force';
    if (!prisma) return res.json({ loop, rows: [], note: '无数据库模式：无法导出历史数据集' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 10), 20000);
    try {
        const rows = await prisma.sensorSample.findMany({ orderBy: { time: 'asc' }, take: limit });
        const t0 = rows.length ? rows[0].time.getTime() : 0;
        const data = rows.map((r) => ({
            t: +((r.time.getTime() - t0) / 1000).toFixed(1),
            u: loop === 'force' ? r.outputForce : r.outputHeight,
            y: loop === 'force' ? r.contactForce : r.height,
            temperature: r.temperature, pressure: r.pressure, humidity: r.humidity
        }));
        res.json({
            loop, count: data.length, unit: loop === 'force' ? { u: 'kPa', y: 'N' } : { u: 'mm', y: 'mm' },
            rows: data,
            note: 'u=控制输出，y=被控量；用于一阶惯性加纯滞后 FOPDT 辨识 K、T、L，再按 Z-N 公式得 Kp、Ti、Td'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.use('/api/v2', createUpgradeRouter({
    // 复用实时 pipeline：REST 直接反映采集链路的告警/链路/工单状态
    pipeline,
    autoCreateOrder: String(process.env.AUTO_CREATE_ORDER || 'true').toLowerCase() !== 'false',
    // 供 /overview 附带的实时评估（控制环测量值 + 式7 健康指数）
    getForce: () => {
        try { return controlEngine.getStatus().computed; } catch { return null; }
    },
    getHealth: () => {
        try {
            const c = controlEngine.getStatus().computed;
            const s = pipeline.lastSample || {};
            const dayAgo = Date.now() - DAY_MS;
            const alarms24 = pipeline.alarms.alarms.filter(a => a.t >= dayAgo).length;
            return pipeline.maint.healthIndex({
                forceMean: c.contactForce, forceTarget: 100, forceStd: 0,
                tempMax: s.temperature, alarmCount24h: alarms24,
            });
        } catch { return null; }
    },
    getClock: () => clockGuard.status(),
    getClockSkew: () => skewTracker.stats(),
}));

// ---------- 平台 3.0：受电弓"一弓一档" + 3 域健康度 + 碳滑板全生命周期 ----------
app.use('/api/v3', createV3Router());

// ---------- SPA 前端路由回退 ----------
// 前端使用 createWebHistory（history 模式），子路由如 /monitor_car、/fault_overview、
// /moterline_pantograph 由浏览器直接请求。缺少回退时刷新或直接访问这些地址
// 会走到 express.static 之后、无人处理，响应 "Cannot GET /xxx"。
// 这里把非 API、非上传的 GET 请求统一回 index.html，交给前端路由解析。
app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    const p = req.path || '';
    // 接口与实时通信交由各自处理器，不参与回退
    if (p.startsWith('/api') || p.startsWith('/socket.io')) return next();
    // 深链（如 /monitor_car）同样返回 index.html，必须与根路径一致不缓存，
    // 否则重新构建后浏览器仍用旧入口，指向已删除的 hash 资源。
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ============================================================
// 5. 启动服务器
// ============================================================
const PORT = process.env.PORT || 3000;
(async () => {
    // 先补齐演示数据再读取历史：保证本次启动的内存列表与超限统计立即包含这 6 条。
    // 3.0：改为"清空重灌"，使演示告警时间始终相对当前时刻新鲜（否则旧记录会让
    // 总览页"今日告警/近7天趋势/30天健康度"恒为 0/100，页面看起来是空的）。
    if (SEED_DEMO_WARNINGS && prisma) {
        try {
            await clearDemoWarnings(prisma);      // 仅删除 [演示数据] 标记记录，不误伤真实数据
            const n = await seedDemoWarnings(prisma);
            console.log(`✅ 已刷新 ${n} 条演示告警（时间相对当前时刻，SEED_DEMO_WARNINGS=false 可关闭）`);
        } catch (err) {
            console.warn('⚠️ 演示告警写入失败（不影响平台启动）:', err.message);
        }
    } else if (SEED_DEMO_WARNINGS && !prisma) {
        // 无数据库模式：演示告警直接注入内存（此前该分支缺失，导致"无库也有演示数据"的说法不成立）
        const demos = buildDemoWarnings();
        for (const d of demos) {
            pushWarning({
                id: nextMemId(),
                code: d.code,
                content: d.content,
                time: d.time.toISOString().slice(0, 10),
                timeFull: d.time.toISOString(),
                worker: d.worker,
                remark: d.remark,
            });
        }
        updateOverLimitStats();
        console.log(`✅ 无数据库模式：已注入 ${demos.length} 条演示告警（内存）`);
    }
    await loadHistoryFromDB();

    // 退出前落盘运行态（工单/告警编号/链路累计），避免强杀丢状态
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            try {
                runtimeStore.set('pipeline', pipeline.serialize());
                runtimeStore.flush();
                persistBoxAlarms(true);      // 黑盒子告警列表落盘（无库模式下的唯一副本）
            } catch { /* ignore */ }
            process.exit(0);
        });
    }

    // 端口占用：给出可操作的提示，而不是抛出一长串 Node 堆栈。
    // 常见原因是上一个平台实例没退干净（重复双击启动脚本）。
    server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
            console.error('');
            console.error(`❌ 端口 ${PORT} 已被占用，平台无法启动。`);
            console.error('   处理办法（任选其一）：');
            console.error(`   1) 关闭已运行的平台窗口/进程后重新启动；`);
            console.error(`   2) 查占用进程：netstat -ano | findstr :${PORT}`);
            console.error(`      然后结束它：taskkill /PID <进程号> /F`);
            console.error(`   3) 换个端口：在 .env 中把 PORT 改为其他未占用端口（如 3001）`);
            console.error('');
        } else {
            console.error('❌ 服务启动失败:', err);
        }
        process.exit(1);
    });

    server.listen(PORT, () => {
        console.log(`✅ Server running on http://localhost:${PORT}`);
        console.log(`📡 WebSocket 服务已启动`);
        console.log(`📁 上传文件保存至: ${uploadDir}`);
        const s = sec.status();
        console.log(`🛡️ 写接口保护: 令牌校验${s.tokenEnabled ? '已启用' : '未启用（设置 API_TOKEN 可启用）'}，限流 ${s.rateLimitPerMin} 次/分/IP`);
        console.log(`🔌 v2 升级接口已挂载: /api/v2（审计 /api/v2/audit，安全状态 /api/v2/security）`);
        auth.announce();
        if (auth.status().enabled && !auth.status().deviceTokenEnabled) {
            console.warn('⚠️ 已启用认证但未配置 API_TOKEN：黑盒子 POST /api/upload-alarm 将被拒绝（设备需 X-API-Token）');
        }
    });

    if (SIMULATION_MODE) {
        startSimulation();
    } else {
        await startRealCollection();
    }

    startControlLoop(); // 双环 PID 控制引擎（模拟/真实模式均驱动）
})();
