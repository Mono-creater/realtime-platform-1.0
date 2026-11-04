/**
 * tests/e2e.js —— 前端端到端测试（真实 Chrome，无第三方依赖）
 *
 * 只覆盖"浏览器里才会炸"的部分：SPA 路由、CSP、图表渲染、WS 订阅后的首屏数据。
 * 用 Chrome DevTools Protocol 直连，不引入 Playwright/Cypress，避免新增依赖与下载。
 *
 * 运行：npm run test:e2e
 * 环境：需本机安装 Chrome；找不到时输出 SKIP 并以 0 退出（不阻塞 CI）。
 *     可用 CHROME_PATH 指定可执行文件。
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, waitFor, createChecker, sleep } = require('./helpers');

const SERVER_PORT = Number(process.env.E2E_PORT || 3192);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9336);

function findChrome() {
    const candidates = [
        process.env.CHROME_PATH,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].filter(Boolean);
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
    return null;
}

async function cdp(pathname, method = 'GET') {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}${pathname}`, { method });
    if (!res.ok) throw new Error(`CDP ${pathname} -> ${res.status}`);
    return res.json();
}

/** 打开一个新标签页并返回求值/关闭能力 */
async function newPage(url) {
    const target = await cdp('/json/new?' + encodeURIComponent(url), 'PUT');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let seq = 0;
    const pending = new Map();
    const problems = [];

    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg.result);
            pending.delete(msg.id);
            return;
        }
        if (msg.method === 'Runtime.exceptionThrown') {
            problems.push('exception: ' + (msg.params.exceptionDetails?.text || ''));
        }
        if (msg.method === 'Log.entryAdded') {
            const t = msg.params.entry?.text || '';
            if (/Content Security Policy|Uncaught|Failed to fetch/i.test(t)) problems.push('log: ' + t);
        }
    };

    const send = (method, params) => new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });

    await new Promise((resolve) => { ws.onopen = resolve; });
    await send('Runtime.enable');
    await send('Log.enable');

    return {
        problems,
        async ev(expression) {
            const r = await send('Runtime.evaluate', {
                expression: `JSON.stringify(${expression})`,
                returnByValue: true,
                awaitPromise: true,
            });
            const raw = r && r.result ? r.result.value : null;
            return raw ? JSON.parse(raw) : null;
        },
        send,
        async close() {
            try { await cdp(`/json/close/${target.id}`, 'GET'); } catch { /* ignore */ }
            try { ws.close(); } catch { /* ignore */ }
        },
    };
}

(async () => {
    const chrome = findChrome();
    if (!chrome) {
        console.log('==== E2E：SKIP（未找到 Chrome，可设 CHROME_PATH 指定）====');
        return;
    }

    const { chk, summary } = createChecker();
    let srv = null;
    let proc = null;
    let profileDir = null;
    const pages = [];

    try {
        srv = await startServer({ port: SERVER_PORT });
        const base = srv.base;

        profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-'));
        proc = spawn(chrome, [
            '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
            `--remote-debugging-port=${CDP_PORT}`,
            `--user-data-dir=${profileDir}`,
            '--window-size=1600,900',
            'about:blank',
        ], { stdio: 'ignore', windowsHide: true });

        await waitFor(async () => {
            try { await cdp('/json/version'); return true; } catch { return false; }
        }, { timeout: 15000, label: 'Chrome CDP 就绪' });

        console.log('==== E2E（真实 Chrome + 真实服务）====');

        /* ---------- 运维中心 ---------- */
        const ops = await newPage(`${base}/ops_center`);
        pages.push(ops);
        await sleep(4500);
        const opsView = await ops.ev(`({
            kpi: document.querySelectorAll('.kpi-card').length,
            text: document.body.innerText
        })`);
        chk('运维中心渲染 6 张 KPI 卡', opsView.kpi === 6, `${opsView.kpi} 张`);
        chk('运维中心含「时钟健康」卡', opsView.text.includes('时钟健康'), '');
        chk('运维中心含「工单闭环」面板', opsView.text.includes('工单闭环'), '');
        chk('运维中心无 404 文案', !opsView.text.includes('Cannot GET'), '');

        /* ---------- 环境参数（WS 订阅 + 实时刷新） ---------- */
        const car = await newPage(`${base}/monitor_car`);
        pages.push(car);
        await sleep(9000);
        const carView = await car.ev(`({
            status: (document.querySelector('.status') || {}).innerText || '',
            values: [...document.querySelectorAll('.sensor-value')].map(e => e.innerText.trim()),
            text: document.body.innerText
        })`);
        const points = /最近\s*(\d+)\s*个数据点/.exec(carView.text);
        chk('环境参数页已连接 WebSocket', carView.status.includes('已连接'), carView.status);
        chk('订阅后收到实时数据（数据点 ≥3）', !!points && Number(points[1]) >= 3, points ? points[1] + ' 点' : '未匹配');
        chk('三路传感器均已渲染（非 0）',
            carView.values.length === 3 && carView.values.every((v) => !/^0(\s|$)/.test(v)),
            carView.values.join(' | '));

        /* ---------- 线路监控（三张表） ---------- */
        const line = await newPage(`${base}/monitor_line`);
        pages.push(line);
        await sleep(4500);
        const lineView = await line.ev(`({
            boards: document.querySelectorAll('.dv-scroll-board').length,
            text: document.body.innerText
        })`);
        chk('线路监控渲染告警/状态滚动表', lineView.boards >= 2, `${lineView.boards} 张`);
        chk('线路监控含受电弓状态总览', lineView.text.includes('受电弓状态总览'), '');

        // 点击告警行 → 受电弓详情页（真实鼠标事件；dv-scroll-board 需真实指针事件）
        const lineRect = await line.ev(`(() => { const el = document.querySelector('.table-section1 .row-item'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        if (lineRect) {
            await line.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: lineRect.x, y: lineRect.y, button: 'left', clickCount: 1 });
            await line.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lineRect.x, y: lineRect.y, button: 'left', clickCount: 1 });
            await sleep(1500);
        }
        const lineNav = await line.ev(`({ path: location.pathname, text: document.body.innerText.slice(0, 40) })`);
        chk('点击告警行跳转受电弓详情页', !!lineNav && lineNav.path === '/moterline_pantograph', lineNav && lineNav.path);
        chk('受电弓详情页含车组选择', !!lineNav && lineNav.text.includes('车组选择'), '');

        /* ---------- 故障总览（真实数据行） ---------- */
        const fault = await newPage(`${base}/fault_overview`);
        pages.push(fault);
        await sleep(3500);
        const faultView = await fault.ev(`({
            rows: document.querySelectorAll('.el-table__row').length,
            text: document.body.innerText
        })`);
        chk('故障总览渲染真实告警行', faultView.rows > 0, `${faultView.rows} 行`);

        /* ---------- 受电弓详情（ECharts 饼图） ---------- */
        const panto = await newPage(`${base}/moterline_pantograph`);
        pages.push(panto);
        await sleep(5000);
        const pantoView = await panto.ev(`({
            canvases: document.querySelectorAll('canvas').length,
            text: document.body.innerText
        })`);
        chk('受电弓详情渲染图表画布', pantoView.canvases >= 1, `${pantoView.canvases} 个 canvas`);
        chk('饼图标题为真实口径', pantoView.text.includes('部件告警构成'), '');
        chk('饼图图例含百分比', /\d+%/.test(pantoView.text), '');

        /* ---------- 黑盒子图传告警页（HTTP 轮询） ---------- */
        const box = await newPage(`${base}/box_alarm_monitor`);
        pages.push(box);
        await sleep(2500);
        const boxView = await box.ev(`({
            title: document.body.innerText.includes('黑盒子上传告警实时监控'),
            polling: document.body.innerText.includes('HTTP 轮询中'),
            empty: document.body.innerText.includes('暂无黑盒子上传告警')
        })`);
        chk('黑盒告警页渲染（标题 + 轮询状态）', boxView.title && boxView.polling, JSON.stringify(boxView));
        chk('无数据时显示空状态提示', boxView.empty === true, '');

        /* ---------- 运行期错误（CSP / 未捕获异常） ---------- */
        const problems = pages.flatMap((p) => p.problems);
        chk('五个页面无 CSP 违规与未捕获异常', problems.length === 0,
            problems.slice(0, 3).join(' | '));

    } catch (err) {
        console.error('❌ E2E 异常:', err.message);
        if (srv) console.error('--- 服务日志（尾部）---\n' + srv.logs().slice(-3000));
        process.exitCode = 1;
    } finally {
        for (const p of pages) { try { await p.close(); } catch { /* ignore */ } }
        if (proc) { try { proc.kill(); } catch { /* ignore */ } }
        if (profileDir) { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ } }
        if (srv) await srv.stop();
        if (!summary('E2E 汇总')) process.exitCode = 1;
    }
})();
