/**
 * tests/integration.js —— HTTP + WebSocket 集成测试
 *
 * 与 tests/smoke_routes.js 的区别：
 *   smoke 只挂载 router、不连 DB、不起 server.js；
 *   本脚本启动【真实进程】，覆盖 .env 加载、静态托管、Socket.IO、pipeline 初始化、
 *   告警落库/内存分支、广播增量帧等"接线"逻辑 —— 这些是单元测试与冒烟测试的盲区。
 *
 * 运行：npm run test:int
 * 隔离：DATABASE_URL='' + 临时 RUNTIME_STATE_FILE，不碰现网 MySQL 与生产快照。
 */

'use strict';

const { io } = require('socket.io-client');
const { startServer, waitFor, createChecker, sleep } = require('./helpers');

const PORT = Number(process.env.TEST_PORT || 3191);

(async () => {
    const { chk, summary } = createChecker();
    const clients = [];
    let srv = null;

    try {
        srv = await startServer({ port: PORT });
        const base = srv.base;

        const J = async (p, opt) => {
            const res = await fetch(base + p, opt);
            let body = null;
            try { body = await res.json(); } catch { /* 非 JSON 响应 */ }
            return { status: res.status, body, headers: res.headers };
        };
        const post = (p, data) => J(p, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data || {}),
        });
        const del = (p) => J(p, { method: 'DELETE' });

        console.log('==== 集成测试（真实 server.js + 真实 WebSocket）====');

        /* ---------- 1. 启动与隔离 ---------- */
        let r = await J('/api/health');
        chk('GET /api/health 200 且 ok=true', r.status === 200 && r.body.ok === true, `mode=${r.body.mode}`);
        chk('运行在模拟模式（不依赖 PLC 硬件）', r.body.mode === 'simulation', r.body.mode);
        chk('数据库已隔离（未连现网）', r.body.db.configured === false, JSON.stringify(r.body.db));
        chk('WebSocket 暴露投递统计', r.body.ws && r.body.ws.mode === 'subscribe', JSON.stringify(r.body.ws));

        /* ---------- 2. 静态托管与安全头 ---------- */
        const html = await fetch(base + '/monitor_car');
        chk('SPA 深链回退 200 + text/html',
            html.status === 200 && /text\/html/.test(html.headers.get('content-type') || ''), String(html.status));
        chk('index.html 不缓存（no-store）',
            (html.headers.get('cache-control') || '').includes('no-store'), html.headers.get('cache-control'));
        chk('CSP 生效（script-src self）',
            (html.headers.get('content-security-policy') || '').includes("script-src 'self'"), '');

        /* ---------- 3. 告警写入 + 详情时间精度 ---------- */
        const now = Date.now();
        const a1 = await post('/api/alert', {
            alarmType: '燃弧超限', code: 'THB-INT-1', worker: 'WX-9', eventId: 'EV-INT-1',
            clientTime: new Date(now + 30000).toISOString(),
            clock: { source: 'gnss', uncertaintyMs: 8 },
            station: '岗厦至会展中心', mileage: 'K8+120', carNumber: '0503',
        });
        chk('POST /api/alert 成功并返回 id', a1.status === 200 && a1.body.success === true && a1.body.id > 0, `id=${a1.body.id}`);
        chk('上报时钟偏差异常被识别（degraded）',
            !!a1.body.clock && a1.body.clock.degraded === true, JSON.stringify(a1.body.clock));

        const d1 = await J('/api/warning/' + a1.body.id);
        chk('详情时间精确到秒（不再是 08:00:00）',
            /\d{2}:\d{2}:\d{2}/.test(d1.body.time || ''), d1.body.time);
        chk('详情保留 eventId', d1.body.eventId === 'EV-INT-1', String(d1.body.eventId));
        chk('详情标记 timeQuality=degraded', d1.body.timeQuality === 'degraded', String(d1.body.timeQuality));
        chk('详情保留运行上下文',
            d1.body.station === '岗厦至会展中心' && d1.body.mileage === 'K8+120',
            `${d1.body.station} / ${d1.body.mileage}`);

        /* ---------- 4. WebSocket 首帧与增量 ---------- */
        const collector = io(base, { transports: ['websocket'], reconnection: false });
        clients.push(collector);
        const frames = [];
        collector.on('fullUpdate', (f) => frames.push(f));
        await waitFor(() => frames.find((f) => f.type === 'full'), { label: 'WS 首帧' });
        chk('WS 首帧为 full 且带版本号', typeof frames[0].version === 'number', `v=${frames[0].version}`);
        chk('首帧不含已废弃的 pieData', !('pieData' in frames[0]), Object.keys(frames[0]).join(','));

        const mark = frames.length;
        const a2 = await post('/api/alert', { alarmType: '导高超限', code: 'THB-INT-2', worker: 'WX-9' });
        const delta = await waitFor(
            () => frames.slice(mark).find((f) => f.type === 'delta'),
            { label: 'WS 增量帧' }
        );
        chk('新增告警触发 delta 帧（只带变化项）',
            Array.isArray(delta.upserts) && delta.upserts.length === 1,
            `upserts=${delta.upserts && delta.upserts.length}`);
        chk('delta 帧不含全量列表', !('warningList' in delta), Object.keys(delta).join(','));

        /* ---------- 5. 删除：404 + removed 帧 ---------- */
        const markDel = frames.length;
        const delRes = await del('/api/warning/' + a2.body.id);
        chk('DELETE /api/warning/:id 成功', delRes.status === 200 && delRes.body.success === true, String(delRes.status));
        const d404 = await J('/api/warning/' + a2.body.id);
        chk('删除后详情返回 404', d404.status === 404, String(d404.status));
        const delFrame = await waitFor(
            () => frames.slice(markDel).find(
                (f) => f.type === 'delta' && Array.isArray(f.removed) && f.removed.includes(a2.body.id)
            ),
            { label: '删除增量帧' }
        );
        chk('删除触发 removed 帧', !!delFrame, JSON.stringify(delFrame && delFrame.removed));

        /* ---------- 6. sensorData 订阅投递 ---------- */
        const sub = io(base, { transports: ['websocket'], reconnection: false });
        const nosub = io(base, { transports: ['websocket'], reconnection: false });
        clients.push(sub, nosub);
        let subFrames = 0, nosubFrames = 0;
        sub.on('sensorData', () => { subFrames += 1; });
        nosub.on('sensorData', () => { nosubFrames += 1; });
        await waitFor(() => sub.connected && nosub.connected, { label: '两个客户端连接' });
        sub.emit('subscribe', ['sensor']);
        await sleep(6500);   // 采样周期 2 s，覆盖 ≥3 个周期
        chk('订阅 sensor 的客户端收到数据（≥2 帧）', subFrames >= 2, `${subFrames} 帧`);
        chk('未订阅客户端收到 0 帧', nosubFrames === 0, `${nosubFrames} 帧`);

        // 传感器环形缓冲：页面晚开也能回填历史趋势（不依赖页面是否一直开着）
        r = await J('/api/sensor/recent');
        chk('传感器环形缓冲积累历史帧（≥2）', r.status === 200 && r.body.count >= 2, `count=${r.body.count}`);
        chk('环形帧含三路数值', !!(r.body.list[r.body.count - 1] || {}).temperature, JSON.stringify(r.body.list[r.body.count - 1] || {}));

        /* ---------- 7. v2 引擎接线 ---------- */
        r = await J('/api/v2/overview');
        chk('v2 overview 反映实时链路（packets>0）', r.status === 200 && r.body.link.packets > 0, `packets=${r.body.link.packets}`);
        chk('pipeline 已消费采样（ingested>0）', r.body.ingested > 0, `ingested=${r.body.ingested}`);
        chk('overview 含时钟字段', 'clock' in r.body && 'clockSkew' in r.body, '');

        r = await post('/api/v2/orders/1/mttr', {});
        chk('工单非法动作被白名单拒绝（400）', r.status === 400, `${r.status} ${(r.body && r.body.error) || ''}`);

        r = await J('/api/v2/kpi');
        chk('KPI 返回可用率/完整率/丢包区间',
            ['availability', 'dataCompleteness', 'lossCI'].every((k) => k in r.body),
            `availability=${r.body.availability}`);

        // 工单导出（CSV 带 BOM，Excel 可直接打开）
        // 注意：Response.text() 会吃掉 UTF-8 BOM，必须按字节校验
        const csvRes = await fetch(base + '/api/v2/orders/export?format=csv');
        const csvBuf = Buffer.from(await csvRes.arrayBuffer());
        const hasBom = csvBuf[0] === 0xEF && csvBuf[1] === 0xBB && csvBuf[2] === 0xBF;
        const csvText = csvBuf.slice(3).toString('utf8');
        chk('工单导出 CSV（BOM + 表头）',
            csvRes.status === 200 && hasBom && csvText.includes('工单号'),
            `${csvBuf.length} 字节 / contentType=${csvRes.headers.get('content-type')}`);

        /* ---------- 8. 时钟接口 ---------- */
        r = await J('/api/clock');
        chk('/api/clock 返回时钟结构', r.status === 200 && r.body.clock && 'source' in r.body.clock,
            `source=${r.body.clock && r.body.clock.source}`);

        /* ---------- 9. 清理模拟数据 ---------- */
        r = await del('/api/simulation/clear');
        chk('清理模拟数据接口可用', r.status === 200 && r.body.success === true, JSON.stringify(r.body));

    } catch (err) {
        console.error('❌ 集成测试异常:', err.message);
        if (srv) console.error('--- 服务日志（尾部）---\n' + srv.logs().slice(-4000));
        process.exitCode = 1;
    } finally {
        for (const c of clients) { try { c.close(); } catch { /* ignore */ } }
        if (srv) await srv.stop();
        if (!summary('集成测试汇总')) process.exitCode = 1;
    }
})();
