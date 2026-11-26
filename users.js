/**
 * users.js —— 用户注册表（MySQL 存储 + 内存回退）
 *
 * 表结构（启动时自动建表/补列，兼容早期只有 id/username/password/role 的 users 表）：
 *   id / username / password(scrypt) / role(admin|operator|viewer) /
 *   display_name / enabled / created_at / last_login_at
 *
 * 无数据库（未配置 DATABASE_URL）时自动退化为进程内内存表，重启丢失，便于演示。
 */

'use strict';

const { hashPassword, verifyPassword } = require('./auth');

const ROLES = ['admin', 'operator', 'viewer'];

function hashToRecord(pw) {
    const { salt, hash } = hashPassword(pw);
    return `scrypt$${salt}$${hash}`;
}
function recordFromHash(str) {
    const parts = String(str || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return null;
    return { salt: parts[1], hash: parts[2] };
}
/** 校验密码：兼容 scrypt$salt$hash（新）与 salt:hash（旧）两种格式 */
function checkPassword(pw, stored) {
    let rec = recordFromHash(stored);
    if (!rec) {
        const parts = String(stored || '').split(':');
        if (parts.length === 2) rec = { salt: parts[0], hash: parts[1] };
    }
    return rec ? verifyPassword(pw, rec) : false;
}

function createUserStore(opts = {}) {
    const getPrisma = opts.getPrisma || (() => opts.prisma || null);
    const log = opts.log || console.log;
    let prisma = null;
    /** @type {Map<number, object>} 内存缓存（有 DB 时为镜像，无 DB 时为唯一数据源） */
    const cache = new Map();
    let seq = 1;
    let dbMode = false;

    const pub = (u) => u && ({
        id: u.id,
        username: u.username,
        role: u.role,
        displayName: u.display_name || '',
        enabled: !!u.enabled,
        createdAt: u.created_at || null,
        lastLoginAt: u.last_login_at || null,
    });

    async function ensureSchema() {
        await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS users (
            id INT NOT NULL AUTO_INCREMENT,
            username VARCHAR(64) NOT NULL,
            password VARCHAR(255) NOT NULL,
            role VARCHAR(16) NOT NULL DEFAULT 'viewer',
            PRIMARY KEY (id),
            UNIQUE KEY uk_users_username (username)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        const cols = await prisma.$queryRawUnsafe(
            "SELECT COLUMN_NAME AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users'"
        );
        const have = new Set((cols || []).map((r) => String(r.c)));
        const alters = [];
        if (!have.has('display_name')) alters.push('ADD COLUMN display_name VARCHAR(64) DEFAULT NULL');
        if (!have.has('enabled')) alters.push('ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 1');
        if (!have.has('created_at')) alters.push('ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
        if (!have.has('last_login_at')) alters.push('ADD COLUMN last_login_at DATETIME DEFAULT NULL');
        for (const a of alters) {
            await prisma.$executeRawUnsafe(`ALTER TABLE users ${a}`);
        }
    }

    async function loadFromDb() {
        const rows = await prisma.$queryRawUnsafe(
            'SELECT id, username, password, role, display_name, enabled, created_at, last_login_at FROM users'
        );
        cache.clear();
        seq = 1;
        for (const r of rows || []) {
            const u = { ...r, enabled: !!Number(r.enabled) };
            cache.set(u.id, u);
            if (u.id >= seq) seq = u.id + 1;
        }
    }

    async function init() {
        prisma = getPrisma();
        if (!prisma) { dbMode = false; return { mode: 'memory' }; }
        try {
            await ensureSchema();
            await loadFromDb();
            dbMode = true;
            return { mode: 'mysql', count: cache.size };
        } catch (err) {
            dbMode = false;
            log(`⚠️ 用户表初始化失败，退回内存模式：${err.message}`);
            return { mode: 'memory', error: err.message };
        }
    }

    function findByUsername(username) {
        const name = String(username || '').trim().toLowerCase();
        for (const u of cache.values()) if (u.username.toLowerCase() === name) return u;
        return null;
    }

    async function create({ username, password, role = 'viewer', displayName = '' }) {
        const name = String(username || '').trim();
        if (!/^[A-Za-z0-9_]{3,32}$/.test(name)) throw new Error('用户名需为 3~32 位字母、数字或下划线');
        if (String(password || '').length < 6) throw new Error('密码至少 6 位');
        if (!ROLES.includes(role)) throw new Error('角色不合法');
        if (findByUsername(name)) throw new Error('用户名已存在');

        const rec = {
            username: name,
            password: hashToRecord(password),
            role,
            display_name: String(displayName || '').trim().slice(0, 64),
            enabled: 1,
            created_at: new Date(),
            last_login_at: null,
        };
        if (dbMode) {
            await prisma.$executeRawUnsafe(
                'INSERT INTO users (username, password, role, display_name, enabled) VALUES (?, ?, ?, ?, 1)',
                rec.username, rec.password, rec.role, rec.display_name
            );
            const rows = await prisma.$queryRawUnsafe(
                'SELECT id, username, password, role, display_name, enabled, created_at, last_login_at FROM users WHERE username = ? LIMIT 1',
                name
            );
            const row = (rows || [])[0];
            const u = { ...row, enabled: true };
            cache.set(u.id, u);
            if (u.id >= seq) seq = u.id + 1;
            return pub(u);
        }
        const u = { id: seq++, ...rec, enabled: true };
        cache.set(u.id, u);
        return pub(u);
    }

    function list() {
        return [...cache.values()]
            .sort((a, b) => (a.id || 0) - (b.id || 0))
            .map(pub);
    }

    function count() { return cache.size; }

    function getById(id) { return cache.get(Number(id)) || null; }

    function isActive(username) {
        const u = findByUsername(username);
        return !!(u && u.enabled);
    }

    async function update(id, patch = {}) {
        const u = getById(id);
        if (!u) throw new Error('用户不存在');
        const sets = [];
        const args = [];
        if (patch.role !== undefined) {
            if (!ROLES.includes(patch.role)) throw new Error('角色不合法');
            sets.push('role = ?'); args.push(patch.role);
        }
        if (patch.displayName !== undefined) {
            sets.push('display_name = ?'); args.push(String(patch.displayName).slice(0, 64));
        }
        if (patch.enabled !== undefined) {
            sets.push('enabled = ?'); args.push(patch.enabled ? 1 : 0);
        }
        if (patch.password !== undefined) {
            if (String(patch.password).length < 6) throw new Error('密码至少 6 位');
            sets.push('password = ?'); args.push(hashToRecord(patch.password));
        }
        if (!sets.length) return pub(u);
        if (dbMode) {
            await prisma.$executeRawUnsafe(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...args, Number(id));
            await loadFromDb();
        } else {
            if (patch.role !== undefined) u.role = patch.role;
            if (patch.displayName !== undefined) u.display_name = String(patch.displayName).slice(0, 64);
            if (patch.enabled !== undefined) u.enabled = !!patch.enabled;
            if (patch.password !== undefined) u.password = hashToRecord(patch.password);
        }
        return pub(getById(id));
    }

    async function remove(id) {
        const u = getById(id);
        if (!u) throw new Error('用户不存在');
        if (dbMode) {
            await prisma.$executeRawUnsafe('DELETE FROM users WHERE id = ?', Number(id));
            await loadFromDb();
        } else {
            cache.delete(Number(id));
        }
        return { ok: true };
    }

    async function touchLogin(id) {
        const u = getById(id);
        if (!u) return;
        if (dbMode) {
            try { await prisma.$executeRawUnsafe('UPDATE users SET last_login_at = NOW() WHERE id = ?', Number(id)); } catch { /* 忽略 */ }
        }
        u.last_login_at = new Date();
    }

    /** 首次启动播种管理员：表为空时用 AUTH_ADMIN_USER/PASS（缺省 admin + 随机密码） */
    async function seedAdmin() {
        if (cache.size > 0) return null;
        const username = process.env.AUTH_ADMIN_USER || 'admin';
        const plain = process.env.AUTH_ADMIN_PASS || require('crypto').randomBytes(5).toString('base64url');
        const pubUser = await create({
            username, password: plain, role: 'admin', displayName: '系统管理员',
        });
        return { ...pubUser, plain: process.env.AUTH_ADMIN_PASS ? null : plain };
    }

    return {
        init, create, list, count, getById, findByUsername, isActive,
        update, remove, touchLogin, seedAdmin,
        get mode() { return dbMode ? 'mysql' : 'memory'; },
        pub, checkPassword,
    };
}

module.exports = { createUserStore, checkPassword, ROLES };
