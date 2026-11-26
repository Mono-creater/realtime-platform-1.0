/**
 * auth.js —— 轻量认证与角色控制（无第三方依赖）
 *
 * 设计目标：
 *   1) **默认关闭**：未设 AUTH_ENABLED=true 时行为与之前完全一致（不影响演示与 175 项测试）；
 *   2) 账号来自环境变量，不依赖数据库（users 表暂未使用，避免为登录强行动表）；
 *   3) 会话用 HMAC 签名令牌 + HttpOnly Cookie，密钥由 runtime-store 持久化（重启不掉线）；
 *   4) 角色两档：viewer（只读）/ operator（可写）。
 *
 * 环境变量：
 *   AUTH_ENABLED=true            启用
 *   AUTH_OPERATOR_USER/PASS      运维账号（可写）；启用时 PASS 必填，否则自动生成并打印
 *   AUTH_VIEWER_USER/PASS        只读账号（可选）
 *   AUTH_PUBLIC_READ=true        未登录可读（默认 true，便于大屏只读展示）
 *   AUTH_SESSION_HOURS=8         会话有效期
 *   AUTH_SECRET                  签名密钥（留空则由 runtime-store 生成并持久化）
 *
 * 注意：本模块只负责“能不能写”，不替代 HTTPS。明文 HTTP 下 Cookie 仍可被截获。
 */

'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'pf_session';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

/** 仅管理员可执行的操作（路径前缀 + 方法，'*' 表示全部方法） */
const ADMIN_ONLY = [
    [/^\/api\/users(\/|$)/, '*'],
    [/^\/api\/warning(\/|$)/, 'DELETE'],
    [/^\/api\/warnings(\/|$)/, '*'],
    [/^\/api\/alarm(\/|$)/, 'DELETE'],
    [/^\/api\/alarms(\/|$)/, 'DELETE'],
    [/^\/api\/v2\/ewma\/sigma(\/|$)/, '*'],
    [/^\/api\/v2\/adaptive\/period(\/|$)/, '*'],
    [/^\/api\/simulation\/clear(\/|$)/, '*'],
];
function isAdminOnly(req) {
    const p = req.path || '';
    return ADMIN_ONLY.some(([re, m]) => re.test(p) && (m === '*' || m === req.method));
}
function rank(role) { return ROLE_RANK[role] || 1; }

function b64url(input) {
    return Buffer.from(input).toString('base64url');
}
function hmac(secret, data) {
    return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}
function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 32);
    return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
function verifyPassword(password, record) {
    if (!record) return false;
    const hash = crypto.scryptSync(String(password), Buffer.from(record.salt, 'hex'), 32);
    return crypto.timingSafeEqual(hash, Buffer.from(record.hash, 'hex'));
}
function parseCookies(req) {
    const raw = req.headers.cookie || '';
    const out = {};
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

/**
 * @param {object} opts
 * @param {boolean} [opts.enabled]
 * @param {string}  [opts.secret]  签名密钥（由调用方从 runtime-store 取，保证重启后会话仍有效）
 */
function createAuth(opts = {}) {
    const enabled = opts.enabled !== undefined
        ? !!opts.enabled
        : String(process.env.AUTH_ENABLED || '').toLowerCase() === 'true';
    const publicRead = String(process.env.AUTH_PUBLIC_READ || 'true').toLowerCase() !== 'false';
    const allowRegister = String(process.env.AUTH_ALLOW_REGISTER || 'true').toLowerCase() !== 'false';
    const sessionHours = Number(process.env.AUTH_SESSION_HOURS) || 8;
    const secret = opts.secret || process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
    /** 设备令牌（与 API_TOKEN 一致）：黑盒子等机器客户端用 X-API-Token 直接写入，无需登录 */
    const deviceToken = String(opts.deviceToken || process.env.API_TOKEN || '').trim();
    /** 用户注册表（users.js 实例）；未提供时只保留环境变量账号 */
    const userStore = opts.users || null;

    /** @type {Array<{u:string, role:string, pass?:object, generated?:boolean}>} */
    const accounts = [];
    const failures = new Map();       // ip -> { count, firstAt }
    /** 已登出的令牌（token 哈希 → 过期时刻）：无状态令牌必须显式吊销，否则登出只是清了浏览器 Cookie */
    const revoked = new Map();
    let loginOk = 0, loginFail = 0, denied = 0;

    const tokenKey = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
    function pruneRevoked() {
        if (revoked.size < 1000) return;
        const now = Date.now();
        for (const [k, exp] of revoked) if (exp < now) revoked.delete(k);
    }

    function addAccount(u, p, role) {
        if (!u) return;
        if (!p) {
            // 启用认证但没给密码：生成一次性随机密码并打印，避免"开了认证却进不去"
            const generated = crypto.randomBytes(6).toString('base64url');
            accounts.push({ u, role, pass: hashPassword(generated), generated: true, plain: generated });
            return;
        }
        accounts.push({ u, role, pass: hashPassword(p) });
    }

    if (enabled) {
        addAccount(process.env.AUTH_ADMIN_USER || 'admin', process.env.AUTH_ADMIN_PASS, 'admin');
        addAccount(process.env.AUTH_OPERATOR_USER || 'operator', process.env.AUTH_OPERATOR_PASS, 'operator');
        addAccount(process.env.AUTH_VIEWER_USER || 'viewer', process.env.AUTH_VIEWER_PASS, 'viewer');
    }

    function issue(user) {
        const payload = {
            u: user.u,
            r: user.role,
            exp: Date.now() + sessionHours * 3600 * 1000,
        };
        if (user.id) payload.id = user.id;
        const body = b64url(JSON.stringify(payload));
        return `${body}.${hmac(secret, body)}`;
    }

    function verify(token) {
        if (!token || typeof token !== 'string') return null;
        if (revoked.has(tokenKey(token))) return null;
        const idx = token.lastIndexOf('.');
        if (idx <= 0) return null;
        const body = token.slice(0, idx);
        const sig = token.slice(idx + 1);
        if (!safeEqual(sig, hmac(secret, body))) return null;
        try {
            const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            if (!payload || !payload.u || !payload.exp || payload.exp < Date.now()) return null;
            return payload;
        } catch { return null; }
    }

    function cookieHeader(token, maxAgeSec) {
        const parts = [
            `${COOKIE_NAME}=${encodeURIComponent(token)}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Lax',
            `Max-Age=${maxAgeSec}`,
        ];
        if (String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true') parts.push('Secure');
        return parts.join('; ');
    }

    function currentUser(req) {
        if (!enabled) return { u: 'anonymous', role: 'admin', anonymous: true };
        const payload = verify(parseCookies(req)[COOKIE_NAME]);
        if (!payload) return null;
        // 注册表中的用户被停用/改角色后，旧令牌即时失效（按用户名查内存镜像，O(1)）
        if (userStore && !payload.a && payload.id) {
            const rec = userStore.getById(payload.id);
            if (!rec || !rec.enabled) return null;
            payload.r = rec.role;
            payload.name = rec.display_name || '';
        }
        return payload;
    }

    const roleOf = (u) => (u && (u.r || u.role)) || 'viewer';

    /** Express 中间件：附加 req.user，并按角色拦截 */
    function middleware() {
        return function authMiddleware(req, res, next) {
            req.user = currentUser(req);
            if (!enabled) return next();

            const p = req.path || '';
            // 登录/注册接口与健康检查放行（健康检查用于探针）
            if (p.startsWith('/api/auth/') || p === '/api/health') return next();
            // 设备上行入口（黑盒子图传）：无登录态，靠 eventId 幂等与设备令牌保护，不参与人工权限体系
            if (p === '/api/upload-alarm') return next();
            if (!p.startsWith('/api/')) return next();       // 静态资源与 SPA 放行

            // 设备令牌：黑盒子/边缘设备没有登录态，凭 X-API-Token 直接写
            if (deviceToken && req.headers['x-api-token']
                && safeEqual(req.headers['x-api-token'], deviceToken)) {
                req.user = { u: 'device', r: 'operator', device: true };
                return next();
            }

            if (!req.user) {
                if (!MUTATING.has(req.method) && publicRead) return next();
                denied += 1;
                return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
            }
            const role = roleOf(req.user);
            if (isAdminOnly(req) && role !== 'admin') {
                denied += 1;
                return res.status(403).json({ error: '该操作仅管理员可执行', code: 'ADMIN_REQUIRED' });
            }
            if (MUTATING.has(req.method) && rank(role) < rank('operator')) {
                denied += 1;
                return res.status(403).json({ error: '只读账号无权执行写操作', code: 'AUTH_FORBIDDEN' });
            }
            return next();
        };
    }

    /** 挂载 /api/auth/* 与管理员用户管理接口 /api/users* */
    function routes(app) {
        app.post('/api/auth/login', async (req, res) => {
            if (!enabled) return res.json({ ok: true, enabled: false, user: { u: 'anonymous', role: 'admin' } });
            const ip = (req.ip || 'unknown').replace(/^::ffff:/, '');
            const now = Date.now();
            const rec = failures.get(ip);
            if (rec && now - rec.firstAt < 5 * 60000 && rec.count >= 8) {
                return res.status(429).json({ error: '尝试过于频繁，请 5 分钟后再试' });
            }

            const { username, password } = req.body || {};
            let ok = false, who = null;
            const acc = accounts.find((a) => a.u === String(username || ''));
            if (acc && verifyPassword(password, acc.pass)) {
                ok = true; who = { u: acc.u, role: acc.role, name: '' };
            } else if (userStore) {
                const u = userStore.findByUsername(username);
                if (u && u.enabled && userStore.checkPassword(password, u.password)) {
                    ok = true;
                    who = { u: u.username, role: u.role, id: u.id, name: u.display_name || '' };
                    userStore.touchLogin(u.id);
                }
            }
            if (!ok) {
                loginFail += 1;
                const cur = failures.get(ip) || { count: 0, firstAt: now };
                cur.count += 1;
                failures.set(ip, cur);
                return res.status(401).json({ error: '用户名或密码错误' });
            }
            loginOk += 1;
            failures.delete(ip);
            const token = issue(who);
            res.setHeader('Set-Cookie', cookieHeader(token, sessionHours * 3600));
            res.json({ ok: true, enabled: true, user: who });
        });

        app.post('/api/auth/register', async (req, res) => {
            if (!enabled) return res.status(400).json({ error: '认证未启用，无需注册' });
            if (!allowRegister) return res.status(403).json({ error: '管理员已关闭自助注册' });
            if (!userStore) return res.status(500).json({ error: '用户表未就绪' });
            const { username, password, displayName } = req.body || {};
            try {
                const u = await userStore.create({ username, password, role: 'viewer', displayName });
                const token = issue({ u: u.username, role: u.role, id: u.id, name: u.displayName });
                res.setHeader('Set-Cookie', cookieHeader(token, sessionHours * 3600));
                res.json({ ok: true, enabled: true, user: { u: u.username, role: u.role, id: u.id, name: u.displayName } });
            } catch (err) {
                return res.status(400).json({ error: err.message || '注册失败' });
            }
        });

        app.post('/api/auth/logout', (req, res) => {
            // 吊销当前令牌（无状态令牌只清 Cookie 的话，旧令牌在有效期内仍可用）
            const token = parseCookies(req)[COOKIE_NAME];
            const payload = verify(token);
            if (payload) {
                revoked.set(tokenKey(token), payload.exp);
                pruneRevoked();
            }
            res.setHeader('Set-Cookie', cookieHeader('', 0));
            res.json({ ok: true });
        });

        app.post('/api/auth/password', async (req, res) => {
            if (!enabled || !userStore) return res.status(400).json({ error: '认证未启用' });
            const me = currentUser(req);
            if (!me) return res.status(401).json({ error: '未登录' });
            const { oldPassword, newPassword } = req.body || {};
            const rec = me.id ? userStore.getById(me.id) : null;
            if (!rec || !userStore.checkPassword(oldPassword, rec.password)) {
                return res.status(400).json({ error: '原密码不正确' });
            }
            try {
                await userStore.update(rec.id, { password: newPassword });
                return res.json({ ok: true });
            } catch (err) {
                return res.status(400).json({ error: err.message });
            }
        });

        // ---------- 管理员：用户管理 ----------
        const requireAdmin = (req, res, next) => {
            if (!enabled) return res.status(400).json({ error: '认证未启用' });
            if (roleOf(req.user) !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
            next();
        };

        app.get('/api/users', requireAdmin, (req, res) => {
            res.json({ list: userStore ? userStore.list() : [], mode: userStore ? userStore.mode : 'none' });
        });

        app.post('/api/users', requireAdmin, async (req, res) => {
            try {
                const { username, password, role, displayName } = req.body || {};
                const u = await userStore.create({ username, password, role: role || 'viewer', displayName });
                res.json({ ok: true, user: u });
            } catch (err) {
                res.status(400).json({ error: err.message || '创建失败' });
            }
        });

        app.patch('/api/users/:id', requireAdmin, async (req, res) => {
            try {
                const me = currentUser(req);
                const id = Number(req.params.id);
                if (me && me.id === id && req.body && req.body.role && req.body.role !== 'admin') {
                    return res.status(400).json({ error: '不能取消自己的管理员角色' });
                }
                const u = await userStore.update(id, req.body || {});
                res.json({ ok: true, user: u });
            } catch (err) {
                res.status(400).json({ error: err.message || '更新失败' });
            }
        });

        app.delete('/api/users/:id', requireAdmin, async (req, res) => {
            try {
                const me = currentUser(req);
                const id = Number(req.params.id);
                if (me && me.id === id) return res.status(400).json({ error: '不能删除当前登录账号' });
                const target = userStore.getById(id);
                if (target && target.role === 'admin' && userStore.list().filter((x) => x.role === 'admin').length <= 1) {
                    return res.status(400).json({ error: '至少保留一个管理员账号' });
                }
                await userStore.remove(id);
                res.json({ ok: true });
            } catch (err) {
                res.status(400).json({ error: err.message || '删除失败' });
            }
        });

        app.get('/api/auth/me', (req, res) => {
            const user = currentUser(req);
            const role = roleOf(user);
            res.json({
                enabled,
                publicRead,
                allowRegister,
                usersMode: userStore ? userStore.mode : 'none',
                // 未启用认证时返回 null，前端据此不做任何拦截
                user: enabled && user
                    ? { u: user.u, role, name: user.name || '', id: user.id || null,
                        canOperate: rank(role) >= rank('operator'), canManage: role === 'admin' }
                    : null,
            });
        });
    }

    function status() {
        return {
            enabled,
            publicRead,
            allowRegister,
            sessionHours,
            accounts: accounts.map((a) => ({ u: a.u, role: a.role, generated: !!a.generated })),
            users: userStore ? { mode: userStore.mode, count: userStore.count() } : { mode: 'none', count: 0 },
            loginOk,
            loginFail,
            denied,
            revoked: revoked.size,
            deviceTokenEnabled: !!deviceToken,
        };
    }

    /** 启动时打印账号信息（含自动生成的一次性密码） */
    function announce(log = console.log) {
        if (!enabled) return log('🔓 认证未启用（设置 AUTH_ENABLED=true 开启；注册表已就绪，开启后即可注册/登录）');
        for (const a of accounts) {
            log(`🔐 环境账号 ${a.u}（${a.role}）${a.generated ? ` 初始密码：${a.plain}（请立即修改 AUTH_*_PASS）` : ''}`);
        }
        if (userStore) log(`👥 注册表账号 ${userStore.count()} 个（${userStore.mode}）`);
        log(`🔐 只读接口${publicRead ? '开放' : '需登录'}；写接口需 operator，删除/标定/用户管理需 admin`);
    }

    return { enabled, middleware, routes, status, announce, verify, issue, accounts };
}

module.exports = { createAuth, hashPassword, verifyPassword, COOKIE_NAME };
