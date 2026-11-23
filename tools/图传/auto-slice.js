#!/usr/bin/env node
/**
 * 告警驱动自动切片守护进程
 *
 * 作用：轮询平台告警，发现「需要视频佐证」的新告警 → 以其发生时刻为 t0 → 调 record-slice-upload.js
 *      从环形缓存里截 [t0-before, t0+after] → 上传（带 eventId，平台侧可去重）。
 *
 * 为什么是边缘盒轮询平台，而不是平台推给边缘盒：
 *   车载边缘盒在 4G NAT 后，平台无法主动连它；轮询是出站连接，穿透 NAT/防火墙。
 *
 * 用法：
 *   node auto-slice.js                 # 常驻（默认每 2s 轮询一次，Ctrl+C 停）
 *   node auto-slice.js --once          # 只轮询一次就退出（联调用）
 *   node auto-slice.js --once --dry    # 只看命中了哪些告警，不真切片
 *   node auto-slice.js --hours 1       # 只处理最近 1 小时内的告警（默认 1）
 *
 * 配置：环境变量 / .env
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

try { process.loadEnvFile(); } catch { /* 无 .env 忽略 */ }

const CONFIG = {
  platformBase: (process.env.PLATFORM_BASE || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
  pollMs: Number(process.env.AUTO_POLL_MS || 2000),
  stateFile: process.env.AUTO_STATE || path.join(__dirname, 'auto-slice-state.json'),
  sliceScript: path.join(__dirname, 'record-slice-upload.js'),
  camIdx: Number(process.env.AUTO_CAM || 1),        // 用第几台相机切（前弓=1）
  before: Number(process.env.AUTO_BEFORE || 10),    // 事件前秒数
  after: Number(process.env.AUTO_AFTER || 10),      // 事件后秒数
  maxAgeMin: Number(process.env.AUTO_MAX_AGE_MIN || 15), // 超过环形窗口的告警直接跳过
  lookbackHours: Number(process.env.AUTO_LOOKBACK_H || 1),
  cooldownMs: Number(process.env.AUTO_COOLDOWN_MS || 8000), // 同机连续切片最小间隔，防雪崩
  triggerTypes: (process.env.AUTO_TRIGGER_TYPES
    || '燃弧超限,电弧烧蚀,裂纹检出,偏磨超限,磨耗到限预警').split(',').map(s => s.trim()).filter(Boolean),
};

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const DRY = args.includes('--dry');
const hoursArg = args.indexOf('--hours');
if (hoursArg >= 0) CONFIG.lookbackHours = Number(args[hoursArg + 1]) || CONFIG.lookbackHours;

// ---------- 状态（已处理告警 id，防重复切片） ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')); } catch { return { handled: {} }; }
}
function saveState(s) {
  const ids = Object.keys(s.handled);
  if (ids.length > 500) {
    ids.sort((a, b) => s.handled[a] - s.handled[b]).slice(0, ids.length - 500)
      .forEach(id => delete s.handled[id]);
  }
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(s, null, 0));
}
const state = loadState();

const ts = () => new Date().toLocaleString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${ts()}]`, ...a);

// ---------- 时钟对齐 ----------
// 平台告警时间是「平台时钟」，切片是在「本机时钟」里找分片。
// 用响应头 Date 估算两者偏差，避免累积漂移切错位置。
let clockSkewMs = 0;
function noteServerClock(res) {
  const d = res.headers.get('date');
  if (!d) return;
  const serverNow = Date.parse(d);
  if (Number.isFinite(serverNow)) clockSkewMs = serverNow - Date.now();
}

async function fetchWarnings() {
  const res = await fetch(`${CONFIG.platformBase}/api/history?limit=50`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`平台 /api/history 返回 ${res.status}`);
  noteServerClock(res);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('/api/history 返回非数组');
  return list;
}

function warningTimeMs(w) {
  const t = w.timeFull || w.time;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function pickCandidates(list) {
  const now = Date.now();
  const out = [];
  for (const w of list) {
    if (w.videoUrl) continue;                                  // 已有视频（含切片回传的记录）不再触发
    if (!CONFIG.triggerTypes.includes(w.content)) continue;     // 只处理需要视频佐证的告警类型
    const ms = warningTimeMs(w);
    if (ms === null) continue;
    const ageMin = (now - (ms - clockSkewMs)) / 60000;          // 换算到本机时钟后的“已过去多久”
    if (ageMin < -0.2 || ageMin > CONFIG.maxAgeMin) continue;   // 太新（时钟超前后）或已出环形窗口
    // 事件的“后 after 秒”还没录完就切，会得到残缺短片；等窗口闭合（+2s 余量）再动手
    if (ageMin * 60 < CONFIG.after + 2) continue;
    if (state.handled[w.id]) continue;
    out.push({ w, ms, ageMin });
  }
  return out;
}

let lastSliceAt = 0;
const inFlight = new Set(); // 正在切片的告警 id：切片耗时会跨过数个轮询周期，必须挡住重复触发

// 从切片脚本输出里取出上传结果 {"success":true,"imageUrl":...}
function parseMedia(out) {
  const hits = [...out.matchAll(/\{[^{}]*"success"\s*:\s*true[^{}]*\}/g)];
  if (!hits.length) return null;
  try { return JSON.parse(hits[hits.length - 1][0]); } catch { return null; }
}

// 把视频回填到原告警上（否则平台列表里该告警永远 video:无）
async function attachMedia(warningId, media, eventId) {
  if (!media || (!media.videoUrl && !media.imageUrl)) return false;
  try {
    const r = await fetch(`${CONFIG.platformBase}/api/warning/${warningId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl: media.imageUrl || '', videoUrl: media.videoUrl || '', eventId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) { log(`⚠️ 回填失败 HTTP ${r.status}`); return false; }
    const j = await r.json();
    log(`↩ 已回填到告警 ${warningId}：video=${j.videoUrl ? '有' : '无'}，广播=${j.broadcast ? '是' : '否（列表已无此条）'}`);
    return true;
  } catch (e) {
    log('⚠️ 回填异常：' + e.message);
    return false;
  }
}

function runSlice(cand) {
  return new Promise((resolve) => {
    const { w, ms } = cand;
    const eventId = `EV-${w.id}`;
    const t0Epoch = Math.floor((ms - clockSkewMs) / 1000); // 本机时钟口径的 epoch 秒
    const argv = [
      CONFIG.sliceScript, 'slice',
      '--cam', String(CONFIG.camIdx),
      '--event', eventId,
      '--t0', String(t0Epoch),
      '--before', String(CONFIG.before),
      '--after', String(CONFIG.after),
      '--faultType', w.content,
    ];
    if (DRY) {
      log(`[dry] 命中告警 id=${w.id} ${w.content} @${new Date(ms).toLocaleString('zh-CN', { hour12: false })} → 将执行 slice ${eventId}`);
      return resolve({ ok: true, dry: true });
    }
    log(`▶ 触发切片 id=${w.id} ${w.content} t0=${new Date(t0Epoch * 1000).toLocaleString('zh-CN', { hour12: false })}（${cand.ageMin.toFixed(1)} 分钟前）`);
    const p = spawn(process.execPath, argv, { cwd: __dirname, env: { ...process.env, NO_PROXY: '*' } });
    let out = '';
    p.stdout.on('data', d => { out += d; process.stdout.write(d); });
    p.stderr.on('data', d => { out += d; process.stderr.write(d); });
    p.on('close', (code) => {
      const ok = code === 0;
      if (ok) log(`✔ ${eventId} 切片完成`);
      else log(`✘ ${eventId} 切片失败 code=${code}`);
      resolve({ ok, out });
    });
  });
}
async function tick() {
  let list;
  try { list = await fetchWarnings(); }
  catch (e) { log('⚠️ 拉取告警失败：' + e.message); return; }

  const cands = pickCandidates(list);
  if (!cands.length) return;

  // 由旧到新处理，避免积压时顺序错乱
  cands.sort((a, b) => a.ms - b.ms);
  for (const c of cands) {
    if (inFlight.has(c.w.id)) continue;
    if (Date.now() - lastSliceAt < CONFIG.cooldownMs) {
      log(`⏳ 冷却中，${c.w.id} 留到下一轮`);
      return;
    }
    inFlight.add(c.w.id);
    let r;
    try { r = await runSlice(c); }
    finally { inFlight.delete(c.w.id); }
    lastSliceAt = Date.now();
    if (r.ok && !DRY) {
      const eventId = `EV-${c.w.id}`;
      const media = parseMedia(r.out);
      if (media) await attachMedia(c.w.id, media, eventId);
      else log(`⚠️ ${eventId} 未解析到上传结果，回填跳过`);
      state.handled[c.w.id] = Date.now();
      saveState(state);
    } else if (/覆盖不足|无覆盖|重叠区都为空/.test(r.out || '')) {
      // 缓存里没有这段（录制刚启动/已被清理）：标记跳过，否则每 2s 重试形成风暴
      log(`⏭ 告警 ${c.w.id} 无缓存覆盖，标记跳过（不再重试）`);
      state.handled[c.w.id] = Date.now();
      saveState(state);
    }
  }
}

(async () => {
  log(`告警驱动切片守护启动：平台 ${CONFIG.platformBase}，相机 #${CONFIG.camIdx}，窗口 t0-${CONFIG.before}s ~ t0+${CONFIG.after}s`);
  log(`监听告警类型：${CONFIG.triggerTypes.join(' / ')}；回看 ${CONFIG.lookbackHours}h${DRY ? '；DRY 模式' : ''}`);
  await tick();
  if (ONCE) return;
  setInterval(tick, CONFIG.pollMs);
  process.on('SIGINT', () => { log('已停止'); process.exit(0); });
})();
