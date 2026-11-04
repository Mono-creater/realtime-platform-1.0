#!/usr/bin/env node
/**
 * camhiPro 摄像头 图传最小闭环：定时抓帧 → POST /api/upload-alarm
 *
 * 依赖：Node >= 18（原生 fetch/FormData/Blob，无需 npm install、无需 ffmpeg）
 * 原理：camhiPro 自带 HTTP 快照接口 /tmpfs/auto.jpg，直接 GET 拿到 JPEG，无需拉 RTSP。
 *
 * 用法：
 *   node grab-upload.js single         每台相机抓一张、上传一次、退出（联调测试用）
 *   node grab-upload.js loop           每 INTERVAL_MS 逐台抓一张循环上传
 *
 * 配置：改下面 CAMERAS，或用环境变量覆盖（.env 也支持）。
 *   双弓各 1 路 = 2 台相机（CAM1_* 前弓 / CAM2_* 后弓），车号共享 CAR_NUMBER。
 */
const fs = require('fs');

try { process.loadEnvFile(); } catch { /* 无 .env 忽略 */ }

// 摄像头列表（双弓各 1 路）
const CAMERAS = [
  {
    camera: process.env.CAM1_CAMERA || '前弓',
    ip:     process.env.CAM1_IP     || '192.168.1.88',
    user:   process.env.CAM1_USER   || 'admin',
    pass:   process.env.CAM1_PASS   || 'admin',
  },
  {
    camera: process.env.CAM2_CAMERA || '后弓',
    ip:     process.env.CAM2_IP     || '192.168.1.89',
    user:   process.env.CAM2_USER   || 'admin',
    pass:   process.env.CAM2_PASS   || 'admin',
  },
];

const CONFIG = {
  snapPath: process.env.CAM_SNAP_PATH || '/tmpfs/auto.jpg', // 已实测确认
  platformUrl: process.env.PLATFORM_URL || 'http://192.168.1.50:3000/api/upload-alarm',
  apiToken:    process.env.API_TOKEN || '',   // 平台若启用令牌，填 X-API-Token
  carNumber: process.env.CAR_NUMBER || 'TQ-019',
  faultType: process.env.FAULT_TYPE || '碳滑板异常磨损',
  intervalMs: Number(process.env.INTERVAL_MS || 5000),
  timeoutMs: Number(process.env.CAM_TIMEOUT_MS || 8000),
};

function snapshotUrl(cam) {
  return `http://${cam.ip}${CONFIG.snapPath}`;
}

function basicAuth(cam) {
  return 'Basic ' + Buffer.from(`${cam.user}:${cam.pass}`).toString('base64');
}

async function grabFrame(cam) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CONFIG.timeoutMs);
  try {
    const res = await fetch(snapshotUrl(cam), {
      headers: { Authorization: basicAuth(cam) },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`相机返回 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('空帧');
    return buf;
  } finally {
    clearTimeout(t);
  }
}

async function upload(cam, jpegBuf) {
  const form = new FormData();
  form.append('image', new Blob([jpegBuf], { type: 'image/jpeg' }), `${cam.camera}-snap.jpg`);
  form.append('timestamp', new Date().toISOString());
  form.append('carNumber', CONFIG.carNumber);
  form.append('camera', cam.camera);
  form.append('faultType', CONFIG.faultType);

  const headers = {};
  if (CONFIG.apiToken) headers['X-API-Token'] = CONFIG.apiToken;

  const res = await fetch(CONFIG.platformUrl, { method: 'POST', body: form, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`平台返回 HTTP ${res.status}: ${text}`);
  return text;
}

async function onceCam(cam) {
  const t0 = Date.now();
  const jpeg = await grabFrame(cam);
  const resp = await upload(cam, jpeg);
  console.log(`[${new Date().toISOString()}] ${cam.camera} 抓帧 ${(jpeg.length / 1024).toFixed(1)} KB，耗时 ${Date.now() - t0} ms → ${resp}`);
}

async function main() {
  const mode = process.argv[2] || 'single';

  console.log('相机列表:');
  for (const cam of CAMERAS) console.log(`  ${cam.camera} → ${snapshotUrl(cam)}`);
  console.log('平台上传地址:', CONFIG.platformUrl);

  if (mode === 'single') {
    for (const cam of CAMERAS) await onceCam(cam);
    return;
  }

  if (mode === 'loop') {
    console.log(`循环模式：每 ${CONFIG.intervalMs} ms 逐台抓一张（Ctrl+C 停止）`);
    let n = 0;
    while (true) {
      const round = ++n;
      for (const cam of CAMERAS) {
        try {
          await onceCam(cam);
        } catch (e) {
          console.error(`[第${round}轮] ${cam.camera} 抓帧/上传失败: ${e.message}`);
        }
      }
      await new Promise((r) => setTimeout(r, CONFIG.intervalMs));
    }
  }

  console.error('用法: node grab-upload.js single|loop');
  process.exit(1);
}

main().catch((e) => {
  console.error('致命错误:', e.message);
  process.exit(1);
});
