/**
 * tests/media.js —— 黑盒子（图传）上传链路集成测试
 *
 * 覆盖：multipart 上传（图 + 文本字段 + 传感器键值）→ 落盘 → 列表查询 → sinceId 增量
 *      → eventId 幂等去重 → 静态访问 → 重启持久化。
 * 隔离：BOX_ALARM_DIR / BOX_ALARM_JSON 指向临时目录，不污染 uploads/。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, createChecker, sleep } = require('./helpers');

const PORT = Number(process.env.MEDIA_TEST_PORT || 3196);

(async () => {
    const { chk, summary } = createChecker();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'box-media-'));
    const boxDir = path.join(tmp, 'box-alarm');
    const jsonPath = path.join(tmp, 'box-alarms.json');
    const env = { BOX_ALARM_DIR: boxDir, BOX_ALARM_JSON: jsonPath, BOX_ALARM_PERSIST: 'true' };
    let srv = null;

    const post = async (base, fields, withMedia = true, eventId = 'EV-BOX-1') => {
        const fd = new FormData();
        if (withMedia) {
            const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]);
            fd.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'snap.jpg');
        }
        for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        if (eventId) fd.append('eventId', eventId);
        const res = await fetch(base + '/api/upload-alarm', { method: 'POST', body: fd });
        let body = null;
        try { body = await res.json(); } catch { /* 非 JSON */ }
        return { status: res.status, body };
    };

    try {
        srv = await startServer({ port: PORT, env });

        console.log('==== 黑盒子图传链路（HTTP 上传 + 轮询）====');

        // 1) 正常上传
        const up = await post(srv.base, {
            carNumber: 'TQ-019', faultType: '碳滑板异常磨损',
            timestamp: '2026-10-23T20:58:00+08:00',
            temperature: '72.5', pressure: '980.3', wearThickness: '18.2',
        });
        chk('POST /api/upload-alarm 成功', up.status === 200 && up.body.success === true && up.body.id > 0, `id=${up.body.id}`);
        chk('图片落盘并返回 URL', typeof up.body.imageUrl === 'string' && up.body.imageUrl.startsWith('/uploads/box-alarm/'), up.body.imageUrl);
        chk('文件确实写入磁盘', fs.existsSync(path.join(boxDir, path.basename(up.body.imageUrl))), '');

        // 2) 列表 + 字段归集
        let r = await (await fetch(srv.base + '/api/get-alarm-list')).json();
        chk('GET /api/get-alarm-list 返回 1 条', r.success === true && r.count === 1, `count=${r.count}`);
        const rec = r.list[0];
        chk('时间按 ISO 存储并换算正确', rec.time === '2026-10-23T12:58:00.000Z', rec.time);
        chk('传感器键值归入 sensorData', rec.sensorData.temperature === '72.5' && rec.sensorData.wearThickness === '18.2',
            JSON.stringify(rec.sensorData));
        chk('车号/故障类型正确', rec.carNumber === 'TQ-019' && rec.faultType === '碳滑板异常磨损', `${rec.carNumber} / ${rec.faultType}`);

        // 3) sinceId 增量
        r = await (await fetch(srv.base + `/api/get-alarm-list?sinceId=${up.body.id}`)).json();
        chk('sinceId 增量返回空列表', r.count === 0, `count=${r.count}`);

        // 4) eventId 幂等
        const dup = await post(srv.base, { carNumber: 'TQ-019', faultType: '重复上报' }, true, 'EV-BOX-1');
        chk('相同 eventId 重复上传被判重', dup.status === 200 && dup.body.duplicated === true && dup.body.id === up.body.id,
            `id=${dup.body.id}`);
        r = await (await fetch(srv.base + '/api/get-alarm-list')).json();
        chk('重复上传未新增记录', r.count === 1, `count=${r.count}`);

        // 5) 静态访问
        const img = await fetch(srv.base + up.body.imageUrl);
        chk('图片可静态访问（200）', img.status === 200, `${img.status} ${img.headers.get('content-type')}`);

        // 6) 缺媒体文件
        const bad = await post(srv.base, { carNumber: 'TQ-000' }, false, 'EV-BOX-2');
        chk('缺少 image/video 返回 400', bad.status === 400, `${bad.status} ${bad.body && bad.body.error}`);

        // 7) 重启持久化
        await sleep(800);                       // 等去抖写盘
        await srv.stop({ keepState: true });
        srv = await startServer({ port: PORT, env });
        r = await (await fetch(srv.base + '/api/get-alarm-list')).json();
        chk('重启后黑盒子告警仍在', r.count === 1 && r.list[0].carNumber === 'TQ-019', `count=${r.count}`);

    } catch (err) {
        console.error('❌ 图传链路测试异常:', err.message);
        if (srv) console.error(srv.logs().slice(-3000));
        process.exitCode = 1;
    } finally {
        if (srv) await srv.stop();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
        if (!summary('图传链路测试汇总')) process.exitCode = 1;
    }
})();
