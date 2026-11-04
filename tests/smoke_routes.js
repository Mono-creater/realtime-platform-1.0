// smoke_routes.js —— REST 接口冒烟测试（仅挂载升级路由，不依赖数据库）
'use strict';
const express = require('express');
const createUpgradeRouter = require('../upgrade-routes.js');

const app = express();
app.use(express.json());
app.use('/api/v2', createUpgradeRouter({ autoCreateOrder: true }));

const server = app.listen(0, async () => {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}/api/v2`;
    const J = async (p, opt) => {
        const r = await fetch(base + p, opt);
        return { status: r.status, body: await r.json() };
    };
    let pass = 0, fail = 0;
    const chk = (name, cond, info) => {
        console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
        cond ? pass++ : fail++;
    };

    console.log('==== REST 冒烟测试（1.0 新增接口）====');

    // 1. EWMA 解析指标
    let r = await J('/ewma/analytics');
    chk('GET /ewma/analytics 返回 σr≈0.4714、δmin≈1.41（论文式(6)/式(12) 口径）',
        r.status === 200 && Math.abs(r.body.sigmaRoc - 0.4714) < 0.001 && Math.abs(r.body.deltaMin - 1.414) < 0.01,
        `σr=${r.body.sigmaRoc} δmin=${r.body.deltaMin}`);

    // 2. 判据自检
    r = await J('/ewma/selfcheck?sigma=1.0');
    chk('GET /ewma/selfcheck?sigma=1.0 → 判据可分辨',
        r.status === 200 && r.body.checks.temperature.ok === true,
        `温度裕度≈${r.body.checks.temperature.margin.toFixed(1)}σr，噪声上限 ${r.body.checks.temperature.sigmaMax.toFixed(2)}`);
    r = await J('/ewma/selfcheck?sigma=3.0');
    chk('GET /ewma/selfcheck?sigma=3.0 → 判据不可分辨（应告警）',
        r.status === 200 && r.body.checks.temperature.ok === false,
        r.body.checks.temperature.advice.slice(0, 40) + '…');

    // 3. 现场标定 σ
    r = await J('/ewma/sigma', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sigma: 1.5 }) });
    chk('POST /ewma/sigma 标定噪声 σ（式(12) 重新校核）',
        r.status === 200 && r.body.analytics.sigma === 1.5, `σr=${r.body.analytics.sigmaRoc}`);

    // 4. RUL（先于 ingest，避免混入不同时间基准的样本）
    const rulBase = Date.now() - 600000;
    for (let t = 0; t <= 600000; t += 60000) {
        await J('/rul/sample', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sig: 'temperature', t: rulBase + t, value: 25 + 1.0 * (t / 60000) }) });
    }
    r = await J('/rul?sig=temperature');
    chk('GET /rul 退化速率 β=1.0、RUL=(80−35)/1=45 min（式8）',
        r.status === 200 && Math.abs(r.body.estimate.beta - 1) < 1e-6 && Math.abs(r.body.estimate.rul - 45) < 0.01,
        `β=${r.body.estimate.beta} RUL=${r.body.estimate.rul} min`);

    // 5. 链路与 Wilson（时间戳须为真实时刻，质量码按"距最近一帧的时长"判定）
    const t0 = Date.now() - 100 * 1000;
    for (let i = 1; i <= 100; i++) {
        await J('/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: t0 + i * 1000, seq: i, temperature: 25, pressure: 500, humidity: 50 }) });
    }
    r = await J('/link');
    chk('GET /link 含 Wilson 区间（0/100 上界 3.7%）',
        r.status === 200 && Math.abs(r.body.lossCI.hi - 0.0370) < 0.0005,
        `gaps=${r.body.gaps} expected=${r.body.expected} hi=${(r.body.lossCI.hi * 100).toFixed(2)}%`);
    chk('GET /link 质量码 GOOD（距最近一帧 < 3 s）', r.body.quality === 'GOOD', `quality=${r.body.quality}`);

    // 5. 自适应变周期
    r = await J('/adaptive/bandwidth');
    const row5 = r.body.table.rows.find((x) => x.lambda === 0.05);
    chk('GET /adaptive/bandwidth λ=5% → 0.388 MB/d、节省 85.5%（论文式(10)，SI 制）',
        r.status === 200 && Math.abs(row5.adaptiveMBperDay - 0.388) < 0.001 && Math.abs(row5.savingVsPa - 85.5) < 0.2,
        `${row5.adaptiveMBperDay} MB/d, ${row5.savingVsPa}%`);

    // 6. 健康指数与综合评估
    r = await J('/health?forceMean=125&forceTarget=100&forceStd=12&tempMax=60&alarmCount24h=4');
    chk('GET /health 健康指数 = 68（计划检修，表15 第 4 行）',
        r.status === 200 && r.body.score === 68 && r.body.grade === '计划检修',
        `score=${r.body.score} (${r.body.grade}) 扣分 ${JSON.stringify(r.body.penalties)}`);

    r = await J('/comprehensive?forceMean=125&forceTarget=100&forceStd=12&tempMax=60&alarmCount24h=4');
    chk('GET /comprehensive 返回健康指数＋RUL 综合评估',
        r.status === 200 && r.body.health && 'rul' in r.body, r.body.summary.slice(0, 46) + '…');

    // 8. 工单状态机（cancel 自 in_progress）
    r = await J('/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'D1', alarmId: 1, level: 'major', description: '冒烟测试' }) });
    const woId = r.body.id;
    await J(`/orders/${woId}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker: 'w1' }) });
    await J(`/orders/${woId}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker: 'w1' }) });
    r = await J(`/orders/${woId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker: 'w1', note: '复核确认误报' }) });
    chk('POST /orders/:id/cancel 允许自 in_progress（表5）', r.status === 200 && r.body.ok === true, `status=${r.body.order && r.body.order.status}`);
    r = await J(`/orders/${woId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker: 'w1', note: '' }) });
    chk('空取消原因被拒绝（论文 §3.1）', r.status === 200 && r.body.ok === false, r.body.error);

    // 9. 告警链路（EWMA 趋势检测驱动）
    r = await J('/alarms');
    chk('GET /alarms 返回引擎统计（含 EWMA 口径）',
        r.status === 200 && r.body.stats.ewma && r.body.stats.ewma.lambda === 0.2,
        `total=${r.body.stats.total} λ=${r.body.stats.ewma.lambda} δmin=${r.body.stats.ewma.deltaMin}`);

    // 10. KPI
    r = await J('/kpi');
    chk('GET /kpi 返回可用率/完整率/丢包率＋Wilson/MTTR',
        r.status === 200 && 'availability' in r.body && 'lossCI' in r.body && 'mttrMin' in r.body,
        `availability=${r.body.availability} lossRate=${r.body.lossRate}`);

    console.log(`\n==== 冒烟汇总：PASS ${pass} / FAIL ${fail} ====`);
    server.close();
    process.exit(fail === 0 ? 0 : 1);
});
