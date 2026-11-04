/**
 * runtime-store.js —— 运行态轻量持久化（无表结构变更）
 *
 * 背景：v2 引擎（告警/工单/链路）原本全部驻留进程内存，重启即清零，
 * 而 warning_history 之外再建表需要 Prisma 迁移（会动用户现网库）。
 * 这里用单个 JSON 文件保存"运行态快照"，写入去抖 + 临时文件原子替换，
 * 既让工单号、告警编号、链路累计量在重启后延续，又零侵入现有表结构。
 *
 * 文件：data/runtime-state.json（已被 .gitignore 忽略的运行产物）
 *
 * 注意：本模块只做"最后一层兜底"，不做跨进程锁。
 *       多实例部署时应改用数据库表（docs 已列遗留项）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

function createStore(file, opts = {}) {
    const debounceMs = opts.debounceMs !== undefined ? opts.debounceMs : 1500;
    const keepSnapshots = opts.keepSnapshots !== undefined ? opts.keepSnapshots : 7;
    const snapshotDir = opts.snapshotDir || path.dirname(file);
    const snapshotPrefix = opts.snapshotPrefix
        || path.basename(file, '.json').replace(/-state$/, '') + '-state-';

    let state = {};
    let timer = null;
    let dirty = false;
    let lastError = null;
    /** 主文件损坏时从哪份快照恢复（供 /api/health 观测） */
    let restoredFrom = null;
    let lastSnapshot = null;

    const dayKey = (d = new Date()) => {
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    };
    const snapshotPath = (d) => path.join(snapshotDir, `${snapshotPrefix}${dayKey(d)}.json`);

    function listSnapshots() {
        try {
            return fs.readdirSync(snapshotDir)
                .filter((f) => f.startsWith(snapshotPrefix) && f.endsWith('.json'))
                .sort()
                .reverse();                 // 文件名含日期，倒序即最新在前
        } catch { return []; }
    }

    // 读取：主文件优先，损坏则回退到最近一份可用快照
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
        else throw new Error('根节点不是对象');
    } catch (err) {
        const existed = fs.existsSync(file);
        state = {};
        if (existed) {
            // 主文件存在但读不出来（截断/损坏）：逐份尝试快照
            for (const name of listSnapshots()) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(path.join(snapshotDir, name), 'utf8'));
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        state = parsed;
                        restoredFrom = name;
                        console.warn(`⚠️ 运行态文件损坏（${err.message}），已从快照恢复：${name}`);
                        break;
                    }
                } catch { /* 继续试上一份 */ }
            }
            if (!restoredFrom) console.warn(`⚠️ 运行态文件损坏且无可用快照，按空状态启动：${err.message}`);
        }
    }

    function saveNow() {
        if (!dirty) return false;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
            fs.renameSync(tmp, file);
            dirty = false;
            lastError = null;
            return true;
        } catch (e) {
            lastError = e.message;
            console.warn('⚠️ 运行态持久化失败（不影响服务）:', e.message);
            return false;
        }
    }

    function touch() {
        dirty = true;
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            saveNow();
        }, debounceMs);
        if (timer.unref) timer.unref();
    }

    /**
     * 每日快照：把当前状态另存一份到 <prefix>YYYYMMDD.json，保留最近 N 份。
     * 用途：主文件损坏/磁盘异常时回退，最多丢一天。
     * @param {boolean} [force] 已有当日快照时是否覆盖
     */
    function snapshot(force = false) {
        try {
            fs.mkdirSync(snapshotDir, { recursive: true });
            const target = snapshotPath();
            if (!force && fs.existsSync(target)) {
                lastSnapshot = path.basename(target);
                return lastSnapshot;
            }
            // 先确保主文件落盘，再从内存状态写快照（避免读到半截文件）
            saveNow();
            const tmp = `${target}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
            fs.renameSync(tmp, target);
            lastSnapshot = path.basename(target);

            const all = listSnapshots();
            for (const old of all.slice(keepSnapshots)) {
                try { fs.unlinkSync(path.join(snapshotDir, old)); } catch { /* ignore */ }
            }
            return lastSnapshot;
        } catch (e) {
            lastError = e.message;
            console.warn('⚠️ 运行态快照失败:', e.message);
            return null;
        }
    }

    // 启动即补一份当日快照；之后每小时检查日期变化（跨天自动再存一份）
    snapshot(false);
    const dailyTimer = setInterval(() => snapshot(false), 60 * 60 * 1000);
    if (dailyTimer.unref) dailyTimer.unref();

    return {
        get(key, dflt) {
            return state[key] !== undefined ? state[key] : dflt;
        },
        set(key, value) {
            state[key] = value;
            touch();
        },
        delete(key) {
            if (state[key] === undefined) return;
            delete state[key];
            touch();
        },
        all() { return state; },
        flush: saveNow,
        snapshot,
        stats() {
            return {
                file,
                keys: Object.keys(state),
                dirty,
                lastError,
                restoredFrom,
                lastSnapshot,
                snapshots: listSnapshots().length,
                keepSnapshots,
            };
        },
    };
}

module.exports = { createStore };
