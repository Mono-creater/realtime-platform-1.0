#!/usr/bin/env node
/**
 * 图传链路自检（零依赖，Node >= 18）
 *   node check-link.js                 自动探测常见相机 IP
 *   node check-link.js 192.168.10.88   指定 IP
 *   node check-link.js 192.168.10.88 --save
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ARG = process.argv.slice(2).find(a => !a.startsWith('--'));
const CANDIDATES = [...new Set([ARG, '192.168.10.88', '192.168.1.88', '192.168.1.6', '192.168.10.89'].filter(Boolean))];
const SNAP = process.env.CAM_SNAP_PATH || '/tmpfs/auto.jpg';
const USER = process.env.CAM_USER || 'admin';
const PASS = process.env.CAM_PASS || '12345678a';

const ok = (m, x = '') => console.log(`  \x1b[32m✔\x1b[0m ${m}${x ? '  ' + x : ''}`);
const bad = (m) => console.log(`  \x1b[31m✘\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const head = (n, t) => console.log(`\n\x1b[1m[${n}] ${t}\x1b[0m`);

const tcpProbe = (host, port, ms = 1200) => new Promise((res) => {
  const s = new net.Socket(); let done = false;
  const fin = (v) => { if (!done) { done = true; s.destroy(); res(v); } };
  s.setTimeout(ms); s.once('connect', () => fin(true)); s.once('timeout', () => fin(false)); s.once('error', () => fin(false));
  s.connect(port, host);
});

async function snap(ip) {
  try {
    const r = await fetch(`http://${ip}${SNAP}`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ok: false, status: r.status };
    const b = Buffer.from(await r.arrayBuffer());
    return { ok: true, bytes: b.length, buf: b };
  } catch (e) { return { ok: false, err: e.message }; }
}

(async () => {
  console.log('\x1b[1m=== 图传链路自检 ' + new Date().toLocaleString('zh-CN') + ' ===\x1b[0m');
  head(1, '本机网卡');
  for (const [n, addrs] of Object.entries(os.networkInterfaces()))
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) ok(`${n} → ${a.address}`);

  head(2, '相机快照');
  let hit = null;
  for (const ip of CANDIDATES) {
    const r = await snap(ip);
    if (r.ok && r.bytes > 1024) { ok(`${ip}${SNAP}`, `${(r.bytes / 1024).toFixed(1)} KB`); hit = { ip, ...r }; break; }
    const alive = await tcpProbe(ip, 80);
    warn(alive ? `${ip} 80 端口通但取不到图（${r.status || r.err}）` : `${ip} 不通`);
  }
  if (!hit) {
    bad('未找到能出图的相机');
    console.log('\n\x1b[36m▶ 检查：相机是否上电 / 是否在 192.168.10.x 网段 / 本机网线是否插在网桥 B 的 LAN 口\x1b[0m');
    process.exitCode = 1; return;
  }
  head(3, '端口');
  ok(`RTSP ${hit.ip}:554 ${await tcpProbe(hit.ip, 554) ? '可用' : '不通'}`);
  ok(`ONVIF ${hit.ip}:8080 ${await tcpProbe(hit.ip, 8080) ? '可用' : '不通'}`);

  if (process.argv.includes('--save')) {
    const f = path.join(__dirname, 'snap-test.jpg');
    fs.writeFileSync(f, hit.buf);
    ok('已保存 ' + f);
  } else warn('加 --save 可存图查看画面');
})();
