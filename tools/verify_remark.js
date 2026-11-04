/**
 * verify_remark.js —— 验证备注列已去除 [演示数据] 标记（前端实际渲染为准）
 *
 * 检查三处：
 *   1) 受电弓详情页「故障预警」滚动板 备注列
 *   2) 告警详细信息页「同位置其他缺陷」表 备注列
 *   3) 监控总览「实时告警」表（无备注列，改查接口返回）
 * 同时确认演示上下文（区站/公里标/车号）未被误删。
 *
 * 用法：node verify_remark.js [baseUrl] [pantographWarningId]
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const WID = process.argv[3] || '423';
const OUT = 'D:/realtime-platform/.work/verify_out';
const W = 1600, H = 894;
const PORT = 9335;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
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
    try { const l = await getJSON(`http://127.0.0.1:${PORT}/json/list`); target = l.find((t) => t.type === 'page'); } catch { /* wait */ }
  }
  if (!target) { console.error('无法连接 Chrome'); chrome.kill(); process.exit(1); }

  const WebSocket = await getWebSocket();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const on = (ev, fn) => (ws.addEventListener ? ws.addEventListener(ev, fn) : ws.on(ev, fn));
  await new Promise((res, rej) => { on('open', res); on('error', rej); });

  let id = 0;
  const pending = new Map();
  on('message', (raw) => { const m = JSON.parse(typeof raw === 'string' ? raw : raw.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (mm, p = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: mm, params: p })); });
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(path.join(OUT, n), Buffer.from(r.result.data, 'base64')); };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  let pass = 0, fail = 0;
  const chk = (n, c, i) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${i ? '  ' + i : ''}`); c ? pass++ : fail++; };

  /* ---- 1) 受电弓详情页：故障预警滚动板 ---- */
  console.log('==== 1) 受电弓详情页 故障预警（备注列）====');
  await send('Page.navigate', { url: BASE + '/moterline_pantograph' });
  await sleep(6000);
  const rows1 = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('.dv-scroll-board .rows .row-item')).map(r => r.innerText.replace(/\\s+/g,' ').trim()))`);
  const list1 = rows1 ? JSON.parse(rows1) : [];
  list1.slice(0, 4).forEach((r) => console.log('    ' + r));
  const remarks1 = list1.map((r) => r.split(' ').slice(5).join(' '));
  chk('故障预警备注列已无 [演示数据]', list1.length > 0 && !list1.some((r) => r.includes('演示数据')),
      list1.length ? `检查 ${list1.length} 行` : '未取到行');
  chk('故障预警备注内容仍完整（非空）', remarks1.every((r) => r && r.length > 4), remarks1[0] || '');
  await shot('remark_pantograph.png');

  /* ---- 2) 告警详细信息页：同位置其他缺陷 ---- */
  console.log(`\n==== 2) 告警详细信息页 id=${WID}（备注 + 上下文）====`);
  await send('Page.navigate', { url: `${BASE}/pantograph-warning?id=${WID}` });
  await sleep(5500);
  const info = await evalJS(`JSON.stringify((() => {
    const txt = document.body.innerText;
    const grid = Array.from(document.querySelectorAll('.info-grid p')).map(p => p.innerText.replace(/\\s+/g,' ').trim());
    const boardRows = Array.from(document.querySelectorAll('.table-section .dv-scroll-board .rows .row-item')).map(r => r.innerText.replace(/\\s+/g,' ').trim());
    return { hasMark: txt.includes('演示数据'), grid, boardRows };
  })())`);
  const inf = info ? JSON.parse(info) : {};
  console.log('    信息行:', (inf.grid || []).slice(0, 6).join(' | '));
  (inf.boardRows || []).forEach((r) => console.log('    缺陷表: ' + r));
  chk('详情页整页文本不含 [演示数据]', inf.hasMark === false, inf.hasMark ? '仍出现' : '无');
  chk('演示上下文保留：区站/公里标/车号仍在',
      (inf.grid || []).some((s) => s.includes('区站')) && (inf.grid || []).some((s) => s.includes('公里标')) && (inf.grid || []).some((s) => s.includes('车号')),
      (inf.grid || []).find((s) => s.includes('区站')) || '');
  await shot('remark_detail.png');

  /* ---- 3) 接口层复核 ---- */
  console.log('\n==== 3) 接口层复核 ====');
  const api = await evalJS(`(async () => {
    const h = await (await fetch('/api/history')).json();
    const d = await (await fetch('/api/warning/${WID}')).json();
    return JSON.stringify({
      historyTotal: h.length,
      historyWithMark: h.filter(x => String(x.remark||'').includes('演示数据')).length,
      historySample: (h.find(x => String(x.code||'').startsWith('THB')) || {}).remark || '',
      detailRemark: d.remark, detailStation: d.station, detailMileage: d.mileage
    });
  })()`);
  const a = api ? JSON.parse(api) : {};
  console.log('    /api/history 含标记条数:', a.historyWithMark, '/', a.historyTotal);
  console.log('    示例备注:', JSON.stringify(a.historySample));
  chk('/api/history 无任何记录带标记', a.historyWithMark === 0, `${a.historyWithMark}`);
  chk('/api/warning/:id 备注干净且上下文完整',
      !!a.detailRemark && !String(a.detailRemark).includes('演示数据') && !!a.detailStation && !!a.detailMileage,
      `${a.detailStation} / ${a.detailMileage}`);

  console.log(`\n==== 验证汇总：PASS ${pass} / FAIL ${fail} ====`);
  console.log('截图输出目录：' + OUT);
  ws.close(); chrome.kill();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('验证异常:', e); process.exit(2); });
