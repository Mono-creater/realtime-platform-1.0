/**
 * tests/store.js —— 运行态存储单元测试（快照 / 损坏回退 / 保留份数）
 *
 * 不启服务，直接测 runtime-store：这是"断电后能否恢复"的最后一道保险。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../runtime-store');
const { createChecker } = require('./helpers');

const { chk, summary } = createChecker();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-store-test-'));
const main = path.join(dir, 'runtime-state.json');

function freshStore(opts = {}) {
    return createStore(main, Object.assign({ snapshotDir: dir, keepSnapshots: 3, debounceMs: 10 }, opts));
}

try {
    console.log('==== 运行态存储（快照与恢复）====');

    // 1) 首次创建
    let s = freshStore();
    chk('首次运行状态为空', Object.keys(s.all()).length === 0, JSON.stringify(s.stats()));
    chk('启动即生成当日快照', s.stats().snapshots >= 1, `snapshots=${s.stats().snapshots}`);

    // 2) 写入 + 快照
    s.set('pipeline', { orders: [{ id: 'WO00007', status: 'new' }], alarms: [] });
    s.flush();
    const snapName = s.snapshot(true);
    chk('手动快照写入成功', !!snapName, String(snapName));
    chk('主文件已落盘', fs.existsSync(main), main);

    // 3) 主文件损坏 → 从快照恢复
    fs.writeFileSync(main, '{ this is not json', 'utf8');
    const s2 = freshStore();
    const restored = s2.get('pipeline', null);
    chk('主文件损坏后自动从快照恢复', !!restored && restored.orders[0].id === 'WO00007',
        JSON.stringify(restored));
    chk('stats.restoredFrom 记录恢复来源', !!s2.stats().restoredFrom, String(s2.stats().restoredFrom));
    chk('恢复后主文件可再次写入', (() => { s2.set('probe', 1); return s2.flush(); })(), '');

    // 4) 保留份数：写多份历史快照，触发裁剪
    for (const d of ['20200101', '20200102', '20200103', '20200104', '20200105']) {
        fs.writeFileSync(path.join(dir, `runtime-state-${d}.json`), JSON.stringify({ old: d }), 'utf8');
    }
    const before = s2.stats().snapshots;
    s2.snapshot(true);
    const after = s2.stats().snapshots;
    chk('快照按 keepSnapshots 裁剪', after <= 3, `before=${before} after=${after}`);

    // 5) 主文件不存在（首次部署）→ 空状态且不误报恢复
    const s3 = createStore(path.join(dir, 'not-exists.json'), { snapshotDir: path.join(dir, 'none') });
    chk('主文件不存在时按空状态启动', Object.keys(s3.all()).length === 0 && s3.stats().restoredFrom === null, '');

} catch (err) {
    console.error('❌ 存储测试异常:', err.message);
    process.exitCode = 1;
} finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (!summary('存储测试汇总')) process.exitCode = 1;
}
