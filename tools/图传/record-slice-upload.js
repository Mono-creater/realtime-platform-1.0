#!/usr/bin/env node
/**
 * 车载弓网图传：双路 ffmpeg 环形缓存 + 事件切片 + 上传
 *
 * 依赖：ffmpeg（PATH 可访问）、Node >= 18（原生 fetch/FormData/Blob）
 * 链路：相机 RTSP(主码流 1080p) → 边缘盒环形缓存 → 事件切片 → POST /api/upload-alarm
 *
 * 子命令：
 *   node record-slice-upload.js record                          # 双路常驻环形缓存（前台，Ctrl+C 停）
 *   node record-slice-upload.js cleanup                         # 只清一次过期分片
 *   node record-slice-upload.js slice --cam 1 --event EV001 \
 *        --t0 "2026-11-01T15:30:00+08:00" [--before 10 --after 10 --faultType 燃弧]
 *
 * 配置：环境变量（.env 也支持），见 CONFIG。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

try { process.loadEnvFile(); } catch { /* 无 .env 忽略 */ }

const CAMERAS = [
  { camera: process.env.CAM1_CAMERA || '前弓', ip: process.env.CAM1_IP || '192.168.1.88',
    user: process.env.CAM1_USER || 'admin', pass: process.env.CAM1_PASS || 'admin',
    rtspPath: process.env.CAM1_RTSP_PATH || '/11' },
  { camera: process.env.CAM2_CAMERA || '后弓', ip: process.env.CAM2_IP || '192.168.1.89',
    user: process.env.CAM2_USER || 'admin', pass: process.env.CAM2_PASS || 'admin',
    rtspPath: process.env.CAM2_RTSP_PATH || '/11' },
];

const CONFIG = {
  cacheRoot:   process.env.CACHE_ROOT   || path.join(__dirname, 'cache'),
  outputRoot:  process.env.OUTPUT_ROOT  || path.join(__dirname, 'output'),
  platformUrl: process.env.PLATFORM_URL || 'http://192.168.1.50:3000/api/upload-alarm',
  apiToken:    process.env.API_TOKEN    || '',
  carNumber:   process.env.CAR_NUMBER   || 'TQ-019',
  segTime:     Number(process.env.SEG_TIME   || 15),   // 每片时长 s
  ringMinutes: Number(process.env.RING_MINUTES || 15), // 环形窗口 min
  rtspPort:    Number(process.env.RTSP_PORT   || 554),
};

function rtspUrl(cam) {
  return `rtsp://${cam.user}:${cam.pass}@${cam.ip}:${CONFIG.rtspPort}${cam.rtspPath}`;
}
function camDir(cam) { return path.join(CONFIG.cacheRoot, cam.camera); }
function ensureDirs() {
  for (const cam of CAMERAS) fs.mkdirSync(camDir(cam), { recursive: true });
  fs.mkdirSync(CONFIG.outputRoot, { recursive: true });
}
function ffmpegExists() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}
function die(msg) { console.error('❌ ' + msg); process.exit(1); }

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const a = { _: [], cam: 1, before: 10, after: 10, faultType: '燃弧' };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--cam') a.cam = Number(argv[++i]) || 1;
    else if (x === '--camera') a.camera = argv[++i];
    else if (x === '--event') a.event = argv[++i];
    else if (x === '--t0') a.t0 = argv[++i];
    else if (x === '--before') a.before = Number(argv[++i]) || 10;
    else if (x === '--after') a.after = Number(argv[++i]) || 10;
    else if (x === '--faultType') a.faultType = argv[++i];
    else a._.push(x);
  }
  return a;
}
function pickCam(a) {
  if (a.camera) {
    const m = CAMERAS.find(c => c.camera === a.camera);
    if (m) return m;
    die(`未找到弓位「${a.camera}」，可选：${CAMERAS.map(c => c.camera).join('/')}`);
  }
  const idx = Math.max(1, Math.min(a.cam, CAMERAS.length)) - 1;
  return CAMERAS[idx];
}
// t0 转 epoch 秒：支持 ISO8601 或纯 unix 秒数字
function t0ToEpoch(t0) {
  if (!t0) die('缺少 --t0（ISO8601 或 unix 秒）');
  if (/^\d{9,}$/.test(t0)) return Number(t0);
  const ms = Date.parse(t0);
  if (isNaN(ms)) die(`无法解析 --t0：${t0}`);
  return Math.floor(ms / 1000);
}

// ---------- 环形缓存 ----------
// 分片文件名 %Y%m%d_%H%M%S.mp4（本地时），解析回本地 epoch 秒
function parseSegName(name) {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.mp4$/.exec(name);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const start = Math.floor(d.getTime() / 1000);
  return { start, end: start + CONFIG.segTime, file: name };
}
function listSegments(cam) {
  const dir = camDir(cam);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(parseSegName).filter(Boolean)
    .sort((a, b) => a.start - b.start);
}
function cleanupSegments() {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - CONFIG.ringMinutes * 60;
  let removed = 0;
  for (const cam of CAMERAS) {
    for (const s of listSegments(cam)) {
      if (s.end < cutoff) {
        try { fs.unlinkSync(path.join(camDir(cam), s.file)); removed++; } catch { /* ignore */ }
      }
    }
  }
  if (removed) console.log(`🧹 清理过期分片 ${removed} 个`);
}

// ---------- ffmpeg 封装 ----------
function runFfmpeg(args) {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) die('ffmpeg 失败: ' + (r.stderr || '').slice(-800));
  return r.stdout || '';
}

async function record() {
  if (!ffmpegExists()) die('未找到 ffmpeg。Windows: winget install Gyan.FFmpeg；Linux: sudo apt install -y ffmpeg');
  ensureDirs();
  const procs = [];
  for (const cam of CAMERAS) {
    const out = path.join(camDir(cam), '%Y%m%d_%H%M%S.mp4');
    const p = spawn('ffmpeg', [
      '-rtsp_transport', 'tcp', '-i', rtspUrl(cam),
      '-c', 'copy', '-f', 'segment',
      '-segment_time', String(CONFIG.segTime), '-reset_timestamps', '1',
      '-strftime', '1', out,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    p.on('exit', (code) => console.log(`⚠️ ${cam.camera} 录制进程退出 code=${code}`));
    procs.push({ cam, p });
    console.log(`🎥 ${cam.camera} 环形缓存启动 → ${camDir(cam)}（${rtspUrl(cam)}）`);
  }
  const timer = setInterval(cleanupSegments, 60 * 1000);
  const shutdown = () => {
    clearInterval(timer);
    for (const { p } of procs) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
    console.log('🛑 已停止所有录制进程');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function slice(a) {
  if (!ffmpegExists()) die('未找到 ffmpeg');
  const cam = pickCam(a);
  const event = a.event || `EV-${Date.now()}`;
  const t0 = t0ToEpoch(a.t0);
  const start = t0 - a.before, end = t0 + a.after;
  const dur = end - start;

  const segs = listSegments(cam);
  const sel = segs.filter(s => s.start < end && s.end > start);
  if (!sel.length) {
    die(`${cam.camera} 缓存中无覆盖 [${start}~${end}] 的分片（环形窗口 ${CONFIG.ringMinutes} min，共 ${segs.length} 片）。确认录制进程在跑、t0 未超出窗口。`);
  }

  const outDir = path.join(CONFIG.outputRoot, event);
  fs.mkdirSync(outDir, { recursive: true });
  const clip = path.join(outDir, `${event}.mp4`);
  const offset = start - sel[0].start; // 相对首个分片起点的偏移

  if (sel.length === 1) {
    runFfmpeg(['-i', path.join(camDir(cam), sel[0].file), '-ss', String(offset), '-t', String(dur), '-c', 'copy', clip]);
  } else {
    const listFile = path.join(outDir, 'concat.txt');
    fs.writeFileSync(listFile, sel.map(s => `file '${path.join(camDir(cam), s.file).replace(/\\/g, '/')}'`).join('\n'));
    runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-ss', String(offset), '-t', String(dur), '-c', 'copy', clip]);
  }
  if (!fs.existsSync(clip)) die('切片生成失败');

  const frame = (rel, name) => {
    const f = path.join(outDir, name);
    runFfmpeg(['-ss', String(rel), '-i', clip, '-frames:v', '1', '-q:v', '2', f]);
    return f;
  };
  const keyBefore = frame(0.2, 'key_before.jpg');
  const keyMid = frame(a.before, 'key_mid.jpg');
  const keyAfter = frame(a.before + a.after - 0.2, 'key_after.jpg');

  console.log(`🎬 ${cam.camera} 切片 [${dur}s] → ${clip}，关键帧 3 张，准备上传`);

  // 上传：video=clip，image=key_mid，事件幂等靠 eventId
  const form = new FormData();
  form.append('video', new Blob([fs.readFileSync(clip)], { type: 'video/mp4' }), `${event}.mp4`);
  form.append('image', new Blob([fs.readFileSync(keyMid)], { type: 'image/jpeg' }), `${event}-mid.jpg`);
  form.append('timestamp', new Date(t0 * 1000).toISOString());
  form.append('eventId', event);
  form.append('carNumber', CONFIG.carNumber);
  form.append('camera', cam.camera);
  form.append('faultType', a.faultType);

  const headers = {};
  if (CONFIG.apiToken) headers['X-API-Token'] = CONFIG.apiToken;
  const res = await fetch(CONFIG.platformUrl, { method: 'POST', body: form, headers });
  const text = await res.text();
  if (!res.ok) die(`平台返回 HTTP ${res.status}: ${text}`);
  console.log(`✅ 上传成功 ${cam.camera} · ${event} → ${text}`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0] || 'record';
  if (cmd === 'record') return record();
  if (cmd === 'cleanup') { ensureDirs(); cleanupSegments(); return; }
  if (cmd === 'slice') return slice(a);
  console.error('用法: node record-slice-upload.js record|cleanup|slice [--cam 1 --event EV001 --t0 ISO]');
  process.exit(1);
}

main().catch((e) => { console.error('致命错误:', e.message); process.exit(1); });
