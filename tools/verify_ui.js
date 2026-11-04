/**
 * verify_fixes.js —— 用真实 Chrome（CDP）验证两处前端修复
 *
 * 验证目标：
 *   1) 监控总览右上角「碳滑板健康度」是否随告警数据变化（修复前恒为 100%）
 *   2) 受电弓详情页「故障预警」滚动板是否真的在循环滚动（修复前静止）
 *
 * 判定方式：
 *   · 健康度：直接读 DOM 中第 4 张统计卡片的数值与颜色
 *   · 滚动：间隔 2.6 s 各读一次滚动板首行文本，并连续截 3 帧比较行内容是否变化
 *
 * 用法：node verify_fixes.js [baseUrl]
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const OUT = 'D:/realtime-platform/.work/verify_out';
const W = 1600, H = 894;
const PORT = 9333;

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
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--disable-gpu', '--hide-scrollbars', '--no-proxy-server',
    '--no-first-run', '--no-default-browser-check',
    `--window-size=${W},${H}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      target = list.find((t) => t.type === 'page');
    } catch { /* 尚未就绪 */ }
  }
  if (!target) { console.error('无法连接 Chrome 调试端口'); chrome.kill(); process.exit(1); }

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
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
      return true;
    }
    return false;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  let pass = 0, fail = 0;
  const chk = (name, cond, info) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
    cond ? pass++ : fail++;
  };

  /* ================= 1. 监控总览：碳滑板健康度 ================= */
  console.log('==== 1) 监控总览 /monitor_global —— 碳滑板健康度 ====');
  await send('Page.navigate', { url: BASE + '/monitor_global' });
  await sleep(6000);   // 等 axios 拉 /api/stats/summary + 图表渲染

  const cards = await evalJS(`JSON.stringify(
    Array.from(document.querySelectorAll('.stat-card')).map(c => ({
      label: (c.querySelector('.stat-label')||{}).textContent || '',
      value: (c.querySelector('.stat-value')||{}).textContent || '',
      color: (c.querySelector('.stat-value')||{}).style ? (c.querySelector('.stat-value').style.color || '') : ''
    }))
  )`);
  const cardList = cards ? JSON.parse(cards) : [];
  console.log('    统计卡片:', JSON.stringify(cardList));

  const healthCard = cardList.find((c) => c.label.includes('健康度'));
  chk('健康度卡片存在', !!healthCard, healthCard ? `值=${healthCard.value} 颜色=${healthCard.color}` : '');
  chk('健康度不再是 100%（反映窗口内 6 条部件告警 → 80%）',
      !!healthCard && healthCard.value === '80%',
      healthCard ? `实际=${healthCard.value}` : '');
  chk('健康度按分值着色（80 分 → 绿色 #00d68f）',
      !!healthCard && healthCard.color.replace(/\s/g, '') === 'rgb(0,214,143)',
      healthCard ? `实际=${healthCard.color}` : '');

  // 后端接口一致性
  const apiRes = await evalJS(`fetch('/api/stats/summary').then(r=>r.json()).then(d=>JSON.stringify({h:d.health, detail:d.healthDetail}))`);
  const api = apiRes ? JSON.parse(apiRes) : null;
  chk('接口 /api/stats/summary 返回 healthDetail（含窗口/计数/扣分）',
      !!api && !!api.detail && api.detail.counted === 6,
      api && api.detail ? `health=${api.h} 计入=${api.detail.counted} 扣分=${api.detail.penalty}` : '');

  await shot('monitor_global.png');

  // 悬浮提示（健康度卡片的 tooltip 内容）
  const tip = await evalJS(`(async () => {
    const el = Array.from(document.querySelectorAll('.stat-card')).find(c => c.textContent.includes('健康度'));
    if (!el) return '';
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    const t = document.querySelector('.el-popper');
    return t ? t.innerText.replace(/\\s+/g, ' ') : '';
  })()`);
  chk('健康度卡片悬浮显示扣分依据', !!tip && tip.includes('统计窗口'),
      tip ? tip.slice(0, 68) + '…' : '未出现 tooltip');

  /* ================= 2. 受电弓详情：故障预警滚动板 ================= */
  console.log('\n==== 2) 受电弓详情 /moterline_pantograph —— 故障预警滚动板 ====');
  await send('Page.navigate', { url: BASE + '/moterline_pantograph' });
  await sleep(6000);

  const boardInfo = await evalJS(`JSON.stringify((() => {
    const b = document.querySelector('.dv-scroll-board');
    if (!b) return { found: false };
    const rows = Array.from(b.querySelectorAll('.rows .row-item')).map(r => r.innerText.replace(/\\s+/g,' ').trim());
    const headerRows = Array.from(b.querySelectorAll('.header .header-item')).map(r => r.innerText.trim());
    return {
      found: true,
      header: headerRows,
      visibleRows: rows.length,
      firstRow: rows[0] || '',
      allRows: rows,
      boardHeight: b.style.height,
      // 源数据行数（用于判断 rowNum 是否被收窄）
      domRowSample: rows.slice(0, 6)
    };
  })())`);
  const bi = boardInfo ? JSON.parse(boardInfo) : { found: false };
  console.log('    滚动板:', JSON.stringify({ found: bi.found, visibleRows: bi.visibleRows, height: bi.boardHeight }));
  chk('滚动板已渲染', bi.found === true);
  chk('滚动板可见行数 ≥ 1', (bi.visibleRows || 0) >= 1, `可见 ${bi.visibleRows} 行`);

  // 连续采样首行文本，判断是否在滚动
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const s = await evalJS(`(() => {
      const b = document.querySelector('.dv-scroll-board');
      if (!b) return '';
      const r = b.querySelector('.rows .row-item');
      return r ? r.innerText.replace(/\\s+/g,' ').trim() : '';
    })()`);
    samples.push(s);
    if (i < 5) await sleep(1100);
  }
  const distinct = new Set(samples.filter(Boolean));
  console.log('    首行采样序列:');
  samples.forEach((s, i) => console.log(`      t=${(i * 1.1).toFixed(1)}s  ${s}`));
  chk('滚动板首行随时间变化 → 正在循环滚动', distinct.size >= 2,
      `出现 ${distinct.size} 种不同首行`);

  await shot('pantograph_scroll.png');

  // 再等一轮并再截一帧，确认是持续滚动而非一次性
  await sleep(2400);
  const s2 = await evalJS(`(() => {
    const b = document.querySelector('.dv-scroll-board');
    const r = b && b.querySelector('.rows .row-item');
    return r ? r.innerText.replace(/\\s+/g,' ').trim() : '';
  })()`);
  await shot('pantograph_scroll2.png');
  chk('滚动持续推进（非一次性动画）', s2 && s2 !== samples[samples.length - 1],
      `t≈6.6s 首行=${s2}`);

  console.log(`\n==== 验证汇总：PASS ${pass} / FAIL ${fail} ====`);
  console.log('截图输出目录：' + OUT);

  ws.close();
  chrome.kill();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('验证脚本异常:', e); process.exit(2); });
