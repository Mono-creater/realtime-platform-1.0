/**
 * upgrade-routes.js —— 升级能力的 REST 入口（1.0 / 1.1）
 *
 * 集成方式（server.js）：
 *   const { createPipeline } = require('./pipeline');
 *   const pipeline = createPipeline({ autoCreateOrder: true });
 *   app.use('/api/v2', createUpgradeRouter({ pipeline }));
 *
 * 1.1 变更（本次优化）：
 *   · 引擎实例改为【可注入】：默认复用 server.js 的实时 pipeline（同一套告警/链路/工单状态），
 *     未注入时才自建实例（便于冒烟测试单独挂载）。
 *   · /kpi 的可用率改为按真实链路中断累计计算（此前 downMs 永不更新 → 恒 1）。
 *   · /orders/:id/:action 改为动作白名单（此前按 typeof fn === 'function' 放行，可调用服务任意方法）。
 *   · 新增 GET /overview：一次取回链路、告警、工单、EWMA、自适应、RUL 的运行态快照。
 *
 * 提供接口：
 *   GET  /api/v2/standards/force-target?v=80&system=AC   目标平均接触力与动态限值
 *   GET  /api/v2/standards/check?v=80&mean=..&std=..     接触力一致性校验
 *   POST /api/v2/ingest                                  采样上报（外部系统接入；内部已由采集链路自动喂入）
 *   GET  /api/v2/alarms                                  告警列表与统计
 *   POST /api/v2/alarms/:id/ack | /clear                 告警确认 / 解除
 *   GET  /api/v2/link                                    链路质量（丢包率＋Wilson 区间、质量码、可用率）
 *   POST /api/v2/link/error                              链路失败 → 下一次退避间隔
 *   GET  /api/v2/orders | POST /api/v2/orders            工单查询 / 创建
 *   POST /api/v2/orders/:id/:action                      工单流转（assign/start/complete/verify/cancel）
 *   GET  /api/v2/health?forceMean=..&forceTarget=..      健康指数与检修建议（式7）
 *   GET  /api/v2/kpi                                     运维 KPI（告警时延、MTTR、可用率、丢包率）
 *   GET  /api/v2/overview                                运行态快照（1.1 新增）
 *   GET  /api/v2/ewma/analytics                          EWMA 解析指标（σeff/σZ/σr/δmin/噪声边界/裕度）
 *   POST /api/v2/ewma/sigma                              现场标定传感器噪声 σ（触发式(12)重新校核）
 *   GET  /api/v2/ewma/selfcheck                          判据自检：δmin ≤ rw 是否成立
 *   GET  /api/v2/adaptive/bandwidth                      自适应变周期带宽核算（式10）
 *   POST /api/v2/adaptive/period                         查询/设置 Pn、Pa
 *   GET  /api/v2/rul?sig=temperature                     退化速率 β 与剩余寿命 RUL（式8）
 *   POST /api/v2/rul/sample                              推入滑窗均值样本（驱动 RUL 拟合）
 *   GET  /api/v2/comprehensive                           健康指数＋退化趋势＋剩余寿命综合评估
 */

'use strict';

const express = require('express');
const std = require('./standards');
const { createPipeline } = require('./pipeline');
const { fixedBandwidth } = require('./adaptive-period');
const ewma = require('./ewma-trend');

/** 工单允许的动作（白名单：禁止通过 URL 调用维护服务的其它方法） */
const ORDER_ACTIONS = ['assign', 'start', 'complete', 'verify', 'cancel'];

module.exports = function createUpgradeRouter(opts = {}) {
    const router = express.Router();
    // 优先复用 server.js 注入的实时 pipeline；独立挂载（冒烟测试）时自建
    const pipeline = opts.pipeline || createPipeline(opts);
    const alarms = pipeline.alarms;
    const link = pipeline.link;
    const maint = pipeline.maint;
    const adaptive = pipeline.adaptive;

    router.get('/standards/force-target', (req, res) => {
        const v = Number(req.query.v) || 0;
        const t = std.targetMeanContactForce(v, { system: req.query.system || 'AC' });
        res.json({ v, system: t.system, target: +t.value.toFixed(2), limits: std.dynamicLimits(t.value), ref: std.STANDARD_REF.forceLaw });
    });

    router.get('/standards/check', (req, res) => {
        const out = std.evaluateContactForce({
            v: Number(req.query.v) || 0, mean: Number(req.query.mean),
            std: req.query.std !== undefined ? Number(req.query.std) : undefined,
            system: req.query.system || 'AC',
        });
        res.json(out);
    });

    router.post('/ingest', (req, res) => {
        const body = req.body || {};
        const out = pipeline.ingest({
            t: body.t !== undefined ? Number(body.t) : Date.now(),
            temperature: body.temperature,
            pressure: body.pressure,
            humidity: body.humidity,
            seq: body.seq,
            deviceId: body.deviceId,
            truthOnsetMs: body.truthOnsetMs,
        });
        res.json({
            ok: true,
            alarms: out.alarms,
            orders: out.orders,
            alarmStats: alarms.stats(),
            link: out.link,
            adaptive: out.adaptive,
            rul: out.rul,
        });
    });

    router.get('/alarms', (req, res) => res.json({ list: alarms.alarms, stats: alarms.stats() }));
    router.post('/alarms/:id/ack', (req, res) => {
        const r = alarms.ack(Number(req.params.id), (req.body || {}).worker);
        if (r.ok) pipeline.touch();
        res.json(r);
    });
    router.post('/alarms/:id/clear', (req, res) => {
        const r = alarms.clear(Number(req.params.id));
        if (r.ok) pipeline.touch();
        res.json(r);
    });

    // 链路质量：附带可用率（论文 §4.5：1 − 中断时长/运行时长）
    router.get('/link', (req, res) => {
        const s = link.stats(Date.now());
        res.json(Object.assign(s, {
            availability: +pipeline.availability().toFixed(4),
            uptimeSec: Math.round((Date.now() - pipeline.startedAt) / 1000),
        }));
    });
    router.post('/link/error', (req, res) => {
        link.onError();
        pipeline.touch();
        res.json({ nextRetryMs: link.nextRetryDelay(), stats: link.stats() });
    });

    // 工单导出（CSV / JSON）：运维中心「导出」按钮；CSV 带 BOM，Excel 直接可读
    router.get('/orders/export', (req, res) => {
        const list = maint.list();
        if (String(req.query.format || '').toLowerCase() === 'json') {
            return res.json({ count: list.length, list });
        }
        const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '');
        const cell = (v) => {
            let s = v === null || v === undefined ? '' : String(v);
            // 防 CSV 公式注入：= + - @ 开头加单引号
            if (/^[=+\-@]/.test(s)) s = `'${s}`;
            return `"${s.replace(/"/g, '""')}"`;
        };
        const header = ['工单号', '设备', '等级', '状态', '处理人', '创建时间', '开始时间', '完成时间', '复核时间', '描述'];
        const rows = list.map((o) => [
            o.id, o.deviceId, o.level, o.status, o.assignee || '',
            fmt(o.createdAt), fmt(o.startedAt), fmt(o.completedAt), fmt(o.verifiedAt),
            o.description || '',
        ]);
        const csv = '\ufeff' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="work-orders.csv"');
        res.send(csv);
    });

    router.get('/orders', (req, res) => res.json({ list: maint.list({ status: req.query.status }), mttr: maint.mttr() }));
    router.post('/orders', (req, res) => {
        const r = maint.create(Object.assign({ at: Date.now() }, req.body || {}));
        pipeline.touch();
        res.json(r);
    });
    router.post('/orders/:id/:action', (req, res) => {
        const { id, action } = req.params;
        // 白名单：仅允许状态机（表5）定义的 5 个动作
        if (!ORDER_ACTIONS.includes(action)) {
            return res.status(400).json({ ok: false, error: `未知动作：${action}（允许：${ORDER_ACTIONS.join('/')}）` });
        }
        const body = req.body || {};
        const r = maint[action].call(maint, id, body.worker, body.at, body.note);
        if (r && r.ok) pipeline.touch();
        res.json(r);
    });

    router.get('/health', (req, res) => {
        const q = req.query;
        res.json(Object.assign(maint.healthIndex({
            forceMean: Number(q.forceMean), forceTarget: Number(q.forceTarget) || 100,
            forceStd: q.forceStd !== undefined ? Number(q.forceStd) : undefined,
            tempMax: q.tempMax !== undefined ? Number(q.tempMax) : undefined,
            alarmCount24h: q.alarmCount24h !== undefined ? Number(q.alarmCount24h) : undefined,
        }), { note: '代理指标，投运前应按线路数据标定（论文式7）' }));
    });

    router.get('/kpi', (req, res) => {
        const now = Date.now();
        const ls = link.stats(now);
        const runtimeMs = Math.max(1, now - pipeline.startedAt);
        const orders = maint.list();
        res.json({
            availability: +std.availability(ls.downMs || 0, runtimeMs).toFixed(4),
            dataCompleteness: +std.dataCompleteness(ls.packets - ls.gaps, Math.max(ls.expected, 1)).toFixed(4),
            lossRate: ls.lossRate, lossCI: ls.lossCI, quality: ls.quality,
            alarmLatency: alarms.stats().latency, mttrMin: maint.mttr(),
            alarms: alarms.stats().byLevel,
            orders: orders.length,
            ordersOpen: orders.filter((o) => o.status !== 'verified' && o.status !== 'cancelled').length,
            ingested: pipeline.ingested,
            adaptivePeriodSec: adaptive.currentPeriod(),
            uptimeSec: Math.round(runtimeMs / 1000),
            standardRef: std.STANDARD_REF,
        });
    });

    /* ==================== 1.1 新增：运行态快照 ==================== */
    router.get('/overview', (req, res) => {
        const now = Date.now();
        const ls = link.stats(now);
        res.json(pipeline.snapshot({
            availability: +pipeline.availability(now).toFixed(4),
            dataCompleteness: +std.dataCompleteness(ls.packets - ls.gaps, Math.max(ls.expected, 1)).toFixed(4),
            mttrMin: maint.mttr(),
            health: typeof opts.getHealth === 'function' ? opts.getHealth() : null,
            force: typeof opts.getForce === 'function' ? opts.getForce() : null,
            clock: typeof opts.getClock === 'function' ? opts.getClock() : null,
            clockSkew: typeof opts.getClockSkew === 'function' ? opts.getClockSkew() : null,
        }));
    });

    /* ==================== 1.0 新增接口 ==================== */

    // EWMA 解析指标（论文 §2.4 式(6)(12)、§4.4 噪声边界）
    router.get('/ewma/analytics', (req, res) => res.json(alarms.analytics()));

    // 现场标定传感器噪声 σ（触发式(12) 重新校核）
    router.post('/ewma/sigma', (req, res) => {
        const sigma = Number((req.body || {}).sigma);
        if (!(sigma > 0)) return res.status(400).json({ ok: false, error: 'sigma 须为正数' });
        const analytics = pipeline.setSigma(sigma);
        res.json({ ok: true, analytics });
    });

    // 判据自检：按当前 σ 与 rw 给出"判据可分辨/不可分辨"结论（论文 §4.4 投运前校核）
    router.get('/ewma/selfcheck', (req, res) => {
        const sigma = req.query.sigma !== undefined ? Number(req.query.sigma) : alarms.cfg.sigma;
        const lambda = req.query.lambda !== undefined ? Number(req.query.lambda) : alarms.cfg.lambda;
        const windowMin = req.query.windowMin !== undefined ? Number(req.query.windowMin) : alarms.cfg.windowMin;
        const out = {};
        for (const sig of ['temperature', 'pressure', 'humidity']) {
            const rw = alarms.cfg.thresholds[sig].rocPerMin.warning;
            out[sig] = ewma.checkNoiseBoundary(rw, sigma, lambda, windowMin);
        }
        res.json({ sigma, lambda, windowMin, checks: out });
    });

    // 自适应变周期带宽核算（式10）
    router.get('/adaptive/bandwidth', (req, res) => {
        const lambdas = (req.query.lambdas ? String(req.query.lambdas).split(',') : ['0.01', '0.05', '0.1', '0.5', '1'])
            .map(Number).filter((x) => !Number.isNaN(x));
        res.json({
            config: adaptive.cfg,
            state: adaptive.state,
            table: adaptive.bandwidthTable(lambdas),
            fixed: {
                pnMBperDay: +fixedBandwidth(adaptive.cfg.pnSec).toFixed(3),
                paMBperDay: +fixedBandwidth(adaptive.cfg.paSec).toFixed(3),
            },
            formula: 'B = 31·[(1−λ)/Pn + λ/Pa]（式10）',
            audit: adaptive.log.slice(-20),
        });
    });

    router.post('/adaptive/period', (req, res) => {
        const b = req.body || {};
        const state = pipeline.setPeriods({ pnSec: b.pnSec, paSec: b.paSec });
        res.json({
            ok: true, state: state.state, periodSec: state.periodSec,
            table: adaptive.bandwidthTable([0.01, 0.05, 0.1, 0.5, 1]),
        });
    });

    // RUL（式8）
    router.get('/rul', (req, res) => {
        const sig = req.query.sig || 'temperature';
        res.json({
            sig,
            estimate: maint.rulEstimate(sig),
            formula: 'RUL = (x_th − x_now)/β（式8）',
            note: '拟合在滑窗均值序列上进行（窄带链路仅上传滑窗均值）',
        });
    });

    router.post('/rul/sample', (req, res) => {
        const b = req.body || {};
        const sig = b.sig || 'temperature';
        const t = b.t !== undefined ? Number(b.t) : Date.now();
        const est = maint.pushSample(sig, t, Number(b.value));
        pipeline.touch();
        res.json({ ok: true, sig, estimate: est });
    });

    // 综合评估：健康指数＋退化趋势＋剩余寿命（论文 §3.2）
    router.get('/comprehensive', (req, res) => {
        const q = req.query;
        res.json(maint.comprehensive({
            forceMean: Number(q.forceMean), forceTarget: Number(q.forceTarget) || 100,
            forceStd: q.forceStd !== undefined ? Number(q.forceStd) : undefined,
            tempMax: q.tempMax !== undefined ? Number(q.tempMax) : undefined,
            alarmCount24h: q.alarmCount24h !== undefined ? Number(q.alarmCount24h) : undefined,
        }));
    });

    return router;
};
