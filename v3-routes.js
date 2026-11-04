/**
 * v3-routes.js —— 平台 3.0 受电弓"一弓一档"数据接口
 *
 * 路由（挂载于 /api/v3）：
 *   GET /pantographs          受电弓档案列表（含 3 域健康度 + 上下文一句话）
 *   GET /pantograph/:id       单架受电弓全量详情（档案 + 3 域 + 滑板 + 换板 + 缺陷 + 时间轴 + 磨耗预测）
 *   GET /carbon-strip/:id     滑板详情（与 /pantograph/:id 的 strip 子集同源，便于前端独立取用）
 *   GET /lines                线网汇总（按线路聚合，供"线网简图"着色/下钻）
 *
 * 数据来源：pantograph-archive.js（典型工况参考值，投运前以现场实测标定替换）。
 */

'use strict';

const archive = require('./pantograph-archive');

function createV3Router() {
    const router = require('express').Router();

    router.get('/pantographs', (req, res) => {
        res.json({ ok: true, count: archive.listPantographs().length, list: archive.listPantographs() });
    });

    router.get('/pantograph/:id', (req, res) => {
        const pg = archive.getPantograph(req.params.id);
        if (!pg) return res.status(404).json({ ok: false, error: `未找到受电弓档案 ${req.params.id}` });
        res.json({ ok: true, data: pg });
    });

    router.get('/carbon-strip/:id', (req, res) => {
        const pg = archive.getPantograph(req.params.id);
        if (!pg) return res.status(404).json({ ok: false, error: `未找到受电弓档案 ${req.params.id}` });
        res.json({
            ok: true,
            data: {
                id: pg.id, train: pg.train, line: pg.line, position: pg.position,
                strip: pg.strip, inspection: pg.inspection,
            },
        });
    });

    router.get('/lines', (req, res) => {
        res.json({ ok: true, list: archive.lineSummary() });
    });

    // 车队汇总（列车总览顶部指标卡）
    router.get('/fleet', (req, res) => {
        res.json({ ok: true, data: archive.fleetSummary() });
    });

    // 全车队换板台账（智慧检修 → 换板台账）
    router.get('/replacements', (req, res) => {
        const list = archive.replacementsAll();
        res.json({ ok: true, count: list.length, list });
    });

    // 检修计划（按剩余厚度 / 剩余寿命 / 健康度排序，尚未发生的作业）
    router.get('/maintenance-plan', (req, res) => {
        const list = archive.maintenancePlan();
        res.json({ ok: true, count: list.length, list });
    });

    return router;
}

module.exports = { createV3Router };
