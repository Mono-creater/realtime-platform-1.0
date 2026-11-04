/**
 * tests/persistence.js —— 运行态持久化（重启后工单仍在）
 *
 * 流程：起服务 → 建一张工单 → 等写入去抖落盘 → 停服（保留状态文件）→ 用同一文件重启
 *      → 断言工单仍在、编号未回绕。
 */

'use strict';

const path = require('path');
const os = require('os');
const { startServer, createChecker, sleep } = require('./helpers');

const PORT = Number(process.env.PERSIST_TEST_PORT || 3193);

(async () => {
    const { chk, summary } = createChecker();
    const stateFile = path.join(os.tmpdir(), `rt-persist-${process.pid}-${Date.now()}.json`);
    const snapshotDir = path.join(os.tmpdir(), `rt-persist-snap-${process.pid}-${Date.now()}`);
    let srv = null;

    try {
        console.log('==== 运行态持久化（重启恢复）====');

        srv = await startServer({ port: PORT, stateFile, snapshotDir });
        let r = await fetch(srv.base + '/api/v2/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: 'D-PERSIST', level: 'major', description: '重启持久化用例' }),
        });
        const created = await r.json();
        chk('创建工单成功', r.status === 200 && !!created.id, created.id);
        const code = created.id;

        // 等待 debounce 落盘（默认 1.5 s）
        await sleep(2500);
        await srv.stop({ keepState: true });
        srv = null;

        // 同一状态文件重启
        srv = await startServer({ port: PORT, stateFile, snapshotDir });
        const listRes = await fetch(srv.base + '/api/v2/orders');
        const listBody = await listRes.json();
        const found = (listBody.list || []).find((o) => o.id === code);
        chk('重启后工单仍存在', !!found, `共 ${(listBody.list || []).length} 条`);
        chk('工单内容一致', found && found.description === '重启持久化用例' && found.deviceId === 'D-PERSIST',
            found && `${found.deviceId} / ${found.description}`);

        const health = await (await fetch(srv.base + '/api/health')).json();
        chk('health 暴露运行态统计', !!health.runtime && typeof health.runtime.snapshots === 'number',
            `snapshots=${health.runtime && health.runtime.snapshots}`);
        chk('正常启动时未触发快照恢复', health.runtime.restoredFrom === null, String(health.runtime.restoredFrom));

        // 编号不回绕：新建的第二张单号应大于第一张
        r = await fetch(srv.base + '/api/v2/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: 'D-PERSIST', level: 'warning', description: '第二张' }),
        });
        const second = await r.json();
        chk('重启后工单号延续（不回绕到 WO00001）',
            second.id !== 'WO00001' || code === 'WO00001',
            `first=${code} second=${second.id}`);

    } catch (err) {
        console.error('❌ 持久化测试异常:', err.message);
        if (srv) console.error(srv.logs().slice(-3000));
        process.exitCode = 1;
    } finally {
        if (srv) await srv.stop();
        if (!summary('持久化测试汇总')) process.exitCode = 1;
    }
})();
