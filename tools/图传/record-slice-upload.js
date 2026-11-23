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

// 相机列表：CAMx_ENABLED=0 或 CAMx_IP 为空即视为未接入（单路部署时把后弓关掉，
// 免得录制进程对着不存在的 IP 反复重连、日志刷屏）
const ALL_CAMERAS = [
  { id: 1, camera: process.env.CAM1_CAMERA || '前弓', ip: process.env.CAM1_IP || '',
    user: process.env.CAM1_USER || 'admin', pass: process.env.CAM1_PASS || 'admin',
    rtspPath: process.env.CAM1_RTSP_PATH || '/11', enabled: process.env.CAM1_ENABLED !== '0' },
  { id: 2, camera: process.env.CAM2_CAMERA || '后弓', ip: process.env.CAM2_IP || '',
    user: process.env.CAM2_USER || 'admin', pass: process.env.CAM2_PASS || 'admin',
    rtspPath: process.env.CAM2_RTSP_PATH || '/11', enabled: process.env.CAM2_ENABLED !== '0' },
];
const CAMERAS = ALL_CAMERAS.filter(c => c.enabled && c.ip);

const CONFIG = {
  cacheRoot:   process.env.CACHE_ROOT   || path.join(__dirname, 'cache'),
  outputRoot:  process.env.OUTPUT_ROOT  || path.join(__dirname, 'output'),
  platformUrl: process.env.PLATFORM_URL || 'http://192.168.1.50:3000/api/upload-alarm',
  apiToken:    process.env.API_TOKEN    || '',
  carNumber:   process.env.CAR_NUMBER   || 'TQ-019',
  segTime:     Number(process.env.SEG_TIME   || 15),   // 每片时长 s
  ringMinutes: Number(process.env.RING_MINUTES || 15), // 环形窗口 min
  rtspPort:    Number(process.env.RTSP_PORT   || 554),
  audio:       process.env.ENABLE_AUDIO === '1',        // 默认不封装音频（G.711 装不进 mp4）
  videoCodec:  (process.env.VIDEO_CODEC || 'copy').toLowerCase(), // copy | h264
};

// ---------- ffmpeg 定位 ----------
// 优先级：FFMPEG_PATH → PATH → 本地 node_modules/@ffmpeg-installer → 图传/摄像头 下的副本
function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) return 'ffmpeg';
  const guesses = [
    path.join(__dirname, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
    path.join(__dirname, '..', '..', '..', '图传', '摄像头', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
  ];
  for (const g of guesses) if (fs.existsSync(g)) return g;
  try {
    const p = require('@ffmpeg-installer/ffmpeg').path;
    if (p && fs.existsSync(p)) return p;
  } catch { /* 未安装 */ }
  return 'ffmpeg';
}
const FFMPEG = resolveFfmpeg();


function rtspUrl(cam) {
  return `rtsp://${cam.user}:${cam.pass}@${cam.ip}:${CONFIG.rtspPort}${cam.rtspPath}`;
}
function camDir(cam) { return path.join(CONFIG.cacheRoot, cam.camera); }
function ensureDirs() {
  for (const cam of CAMERAS) fs.mkdirSync(camDir(cam), { recursive: true });
  fs.mkdirSync(CONFIG.outputRoot, { recursive: true });
}
function ffmpegExists() {
  return spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0;
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
  // 按相机编号匹配（单路部署时 CAM2 被禁用，--cam 1 仍要选中前弓）
  const byId = CAMERAS.find(c => c.id === a.cam);
  if (byId) return byId;
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
    .map((name) => {
      const s = parseSegName(name);
      if (!s) return null;
      // 正在写入的分片名义 end=start+segTime，但文件只写到当前时刻：
      // 用 mtime 夹住真实可读范围，避免截出“名义 20s、实际 6s”的片子。
      try {
        const written = Math.floor(fs.statSync(path.join(dir, name)).mtimeMs / 1000);
        s.end = Math.min(s.end, Math.max(s.start, written));
      } catch { /* stat 失败按名义值 */ }
      return s;
    })
    .filter(Boolean)
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
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  if (r.status !== 0) die('ffmpeg 失败: ' + (r.stderr || '').slice(-800));
  return r.stdout || '';
}

// 读真实片长（秒）：ffmpeg -i 的 stderr 里解析 Duration（不依赖 ffprobe）
function probeDuration(file) {
  const r = spawnSync(FFMPEG, ['-i', file], { encoding: 'utf8' });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr || '');
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

async function record() {
  if (!ffmpegExists()) die('未找到 ffmpeg。Windows: winget install Gyan.FFmpeg；Linux: sudo apt install -y ffmpeg');
  if (!CAMERAS.length) die('没有启用任何相机：检查 .env 的 CAM1_IP / CAM1_ENABLED');
  ensureDirs();
  const off = ALL_CAMERAS.filter(c => !CAMERAS.includes(c)).map(c => c.camera);
  console.log(`🎥 启用 ${CAMERAS.length} 路：${CAMERAS.map(c => `${c.camera}(${c.ip})`).join('、')}` +
    (off.length ? `；未接入：${off.join('、')}` : ''));
  const procs = [];
  for (const cam of CAMERAS) {
    const out = path.join(camDir(cam), '%Y%m%d_%H%M%S.mp4');
    const args = [
      '-rtsp_transport', 'tcp', '-i', rtspUrl(cam),
      ...(CONFIG.audio ? ['-c', 'copy'] : ['-c:v', 'copy', '-an']),
      '-f', 'segment',
      '-segment_time', String(CONFIG.segTime), '-reset_timestamps', '1',
      '-strftime', '1', out,
    ];
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'ignore'] });
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
  const wantDur = end - start;

  const segs = listSegments(cam);
  const sel = segs.filter(s => s.start < end && s.end > start);
  if (!sel.length) {
    die(`${cam.camera} 缓存中无覆盖 [${start}~${end}] 的分片（环形窗口 ${CONFIG.ringMinutes} min，共 ${segs.length} 片）。确认录制进程在跑、t0 未超出窗口。`);
  }

  // 分片边界会漂移：把请求窗口裁到实际覆盖范围内，避免负偏移/负时长
  const realStart = Math.max(start, sel[0].start);
  const realEnd = Math.min(end, sel[sel.length - 1].end);
  if (realEnd - realStart < 1) die(`${cam.camera} 覆盖不足：请求 [${start}~${end}]，实际可用 [${sel[0].start}~${sel[sel.length - 1].end}]`);
  const offset = realStart - sel[0].start;
  const dur = realEnd - realStart;
  // -c copy 只能从关键帧起切，首尾各有 ≤GOP 长度的误差，短 3s 内不算异常
  if (wantDur - dur > 3) {
    console.warn(`⚠️ 覆盖不足：请求 ${wantDur}s，实际只截到 ${dur}s（环形缓存刚开始录或 t0 太靠前）`);
  }

  const outDir = path.join(CONFIG.outputRoot, event);
  fs.mkdirSync(outDir, { recursive: true });
  const clip = path.join(outDir, `${event}.mp4`);

  // 浏览器 <video> 直接播：mp4 需要 moov 前置（+faststart），音频丢弃（G.711 装不进 mp4）
  const muxArgs = [
    ...(CONFIG.videoCodec === 'h264'
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-an']
      : ['-c', 'copy', '-an']),
    '-movflags', '+faststart',
  ];

  // 逐片截取再拼接：直接把 -ss 加在 concat 输入上会在分片边界上定位不准，
  // 出现“请求 20s 实际 14s”的残缺片。逐片算重叠区间后各截一段最稳。
  const parts = [];
  for (const s of sel) {
    const a = Math.max(realStart, s.start);
    const b = Math.min(realEnd, s.end);
    if (b - a < 0.2) continue;
    const part = path.join(outDir, `part_${s.start}.mp4`);
    runFfmpeg(['-y', '-ss', (a - s.start).toFixed(2), '-i', path.join(camDir(cam), s.file),
      '-t', (b - a).toFixed(2), '-c', 'copy', '-an', part]);
    parts.push(part);
  }
  if (!parts.length) die('所有分片重叠区都为空，无法切片');

  const listFile = path.join(outDir, 'concat.txt');
  fs.writeFileSync(listFile, parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, ...muxArgs, clip]);
  for (const p of parts) { try { fs.unlinkSync(p); } catch { /* 忽略 */ } }
  try { fs.unlinkSync(listFile); } catch { /* 忽略 */ }
  if (!fs.existsSync(clip)) die('切片生成失败');

  const realDur = probeDuration(clip) || dur; // 关键帧对齐后实际片长可能略短
  const frame = (rel, name) => {
    const f = path.join(outDir, name);
    const t = Math.max(0, Math.min(rel, realDur - 0.3)); // 夹到片内，避免取到片尾外
    runFfmpeg(['-y', '-ss', t.toFixed(2), '-i', clip, '-frames:v', '1', '-q:v', '2', f]);
    return fs.existsSync(f) ? f : null;
  };
  const keyBefore = frame(0.2, 'key_before.jpg');
  const keyMid = frame(Math.min(realDur / 2, a.before), 'key_mid.jpg') || keyBefore;
  const keyAfter = frame(realDur - 0.3, 'key_after.jpg') || keyMid;
  if (!keyMid) die('关键帧抽取失败（片内无可解帧）');

  console.log(`🎬 ${cam.camera} 切片 [${realDur.toFixed(1)}s] → ${clip}，关键帧 ${[keyBefore, keyMid, keyAfter].filter(Boolean).length} 张，准备上传`);

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
