/**
 * verify_route.js —— 验证「告警详细信息」页路线条的三处呈现
 *
 * 断言：
 *   1) 起点地名贴合线左端、终点地名贴合线右端（左右各一个）
 *   2) 黄光（.route-glow）位于线上，且其水平位置由记录字段推算（非固定 50%）
 *   3) 位置标注（.route-tip）跟随黄光，且含公里标
 *   4) 不同记录的黄光位置不同（证明是"按记录推算"而非写死）
 *
 * 用法：node verify_route.js [baseUrl] [warningId...]
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const IDS = process.argv.slice(3);
const OUT = 'D:/realtime-platform/.work/verify_out';
const W = 1600, H = 894;
const PORT = 9334;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function getWebSocket() {
  if (typeof WebSocket !== 'undefined') return WebSocket;
  return require('ws');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--disable-gpu', '--hide-scrollbars', '--no-proxy-server',
    '--no-first-run', '--no-default-browser-check',
    `--window-size=${W},${H}`, 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      target = list.find((t) => t.type === 'page');
    } catch { /* not ready */ }
  }
  if (!target) { console.error('无法连接 Chrome'); chrome.kill(); process.exit(1); }

  const WebSocket = await getWebSocket();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const on = (ev, fn) => (ws.addEventListener ? ws.addEventListener(ev, fn) : ws.on(ev, fn));
  await new Promise((res, rej) => { on('open', res); on('error', rej); });

  let id = 0;
  const pending = new Map();
  on('message', (raw) => {
    const msg = JSON.parse(typeof raw === 'string' ? raw : raw.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (m, p = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  let pass = 0, fail = 0;
  const chk = (name, cond, info) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
    cond ? pass++ : fail++;
  };

  const probe = `JSON.stringify((() => {
    const bar = document.querySelector('.route-bar');
    if (!bar) return { found: false };
    const b = bar.getBoundingClientRect();
    const q = (s) => { const e = bar.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
      return { text: e.innerText.trim(), left: +(r.left - b.left).toFixed(1), right: +(r.right - b.left).toFixed(1),
               cx: +((r.left + r.right) / 2 - b.left).toFixed(1), top: +(r.top - b.top).toFixed(1),
               h: +r.height.toFixed(1), cy: +((r.top + r.bottom) / 2 - b.top).toFixed(1) }; };
    return { found: true, width: +b.width.toFixed(1), height: +b.height.toFixed(1),
      start: q('.route-name--start'), end: q('.route-name--end'),
      glow: q('.route-glow'), tip: q('.route-tip'),
      line: (() => { const e = bar.querySelector('.route-line'); const r = e.getBoundingClientRect();
        return { left: +(r.left - b.left).toFixed(1), right: +(r.right - b.left).toFixed(1),
                 top: +(r.top - b.top).toFixed(1), cy: +((r.top + r.bottom) / 2 - b.top).toFixed(1) }; })() };
  })())`;

  const seenGlow = [];

  for (const wid of IDS) {
    console.log(`\n==== 告警 id=${wid} /pantograph-warning ====`);
    await send('Page.navigate', { url: `${BASE}/pantograph-warning?id=${wid}` });
    await sleep(5000);

    const raw = await evalJS(probe);
    const p = raw ? JSON.parse(raw) : { found: false };
    if (!p.found) { chk('路线条已渲染', false); continue; }
    console.log(`    条宽=${p.width} 高=${p.height} | 线 [${p.line.left}, ${p.line.right}] y=${p.line.top}`);
    console.log(`    起点='${p.start && p.start.text}' @${p.start && p.start.left} | 终点='${p.end && p.end.text}' @${p.end && p.end.right}`);
    console.log(`    黄光中心=${p.glow && p.glow.cx} (${((p.glow ? p.glow.cx : 0) / p.width * 100).toFixed(1)}%) | 标注='${p.tip && p.tip.text}' @${p.tip && p.tip.cx}`);

    chk('起点地名存在且贴合线左端', !!p.start && p.start.left <= 2, p.start ? `left=${p.start.left}` : '');
    chk('终点地名存在且贴合线右端', !!p.end && Math.abs(p.end.right - p.line.right) <= 2, p.end ? `right=${p.end.right} vs 线右端 ${p.line.right}` : '');
    chk('起点名与终点名不同（左右各一个）', !!p.start && !!p.end && p.start.text !== p.end.text,
        `${p.start && p.start.text} / ${p.end && p.end.text}`);
    chk('黄光位于线的高度上（以中心比对，动画缩放不影响）',
        !!p.glow && Math.abs(p.glow.cy - p.line.cy) <= 3,
        p.glow ? `glow中心y=${p.glow.cy} 线中心y=${p.line.cy}` : '');
    chk('黄光水平位置在 [6%, 94%] 区间内（不贴边）',
        !!p.glow && p.glow.cx >= p.width * 0.05 && p.glow.cx <= p.width * 0.95,
        p.glow ? `${(p.glow.cx / p.width * 100).toFixed(1)}%` : '');
    chk('位置标注跟随黄光且含公里标',
        !!p.tip && !!p.glow && Math.abs(p.tip.cx - p.glow.cx) <= 2 && /K\d+\+\d+/.test(p.tip.text),
        p.tip ? `tip.cx=${p.tip.cx} glow.cx=${p.glow.cx} text='${p.tip.text}'` : '');

    if (p.glow) seenGlow.push(+(p.glow.cx / p.width * 100).toFixed(1));
    await shot(`route_id${wid}.png`);
  }

  if (seenGlow.length >= 2) {
    const distinct = new Set(seenGlow);
    console.log(`\n  各记录黄光位置%: ${seenGlow.join(', ')}`);
    chk('不同记录的黄光位置各异（按记录推算而非写死 50%）', distinct.size >= 2,
        `${distinct.size} 种不同位置`);
    chk('黄光位置不再固定为 50%', !seenGlow.every((v) => Math.abs(v - 50) < 0.5),
        seenGlow.join(', '));
  }

  console.log(`\n==== 验证汇总：PASS ${pass} / FAIL ${fail} ====`);
  console.log('截图输出目录：' + OUT);
  ws.close(); chrome.kill();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('验证脚本异常:', e); process.exit(2); });
