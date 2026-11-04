/**
 * security.js —— 平台最小安全能力（写接口令牌校验 / 频率限制 / 操作审计 / 上传白名单 / 安全响应头）
 *
 * 设计原则：
 *   1. **默认不改变现网行为**：未配置 API_TOKEN 时不启用令牌校验，未配置 CORS_ORIGIN 时保持原有宽松 CORS，
 *      因此挂载本模块不会让现有前端与大屏失效。
 *   2. **只保护写操作**：GET 一律放行（只读查询），POST/PUT/PATCH/DELETE 才校验与限流。
 *   3. **零第三方依赖**：仅用 Node 内置模块，便于离线部署与单测。
 *
 * 集成方式（server.js 顶部三行）：
 *   const security = require('./security');
 *   const sec = security.createSecurity();
 *   app.use(cors(sec.corsOptions()));
 *   app.use(sec.middleware());
 *
 * 环境变量：
 *   API_TOKEN          非空即启用写接口令牌校验；请求需带 `X-API-Token: <token>` 或 `Authorization: Bearer <token>`
 *   RATE_LIMIT_PER_MIN 每个来源 IP 每分钟允许的写请求数（默认 120，令牌桶）
 *   AUDIT_LIMIT        审计环形缓冲条数（默认 500）
 *   CORS_ORIGIN        允许的跨域来源，逗号分隔；留空表示不限制（保持原行为）
 *   SECURITY_HEADERS   置 off 可关闭安全响应头（默认开启）
 *   UPLOAD_ALLOWED_EXT 允许上传的扩展名，默认 jpg,jpeg,png,webp,gif,bmp,mp4,webm,mov,pdf
 *   UPLOAD_MAX_MB      单文件大小上限 MB（默认 50）
 */

'use strict';

const crypto = require('crypto');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 常量时间字符串比较（先哈希再比较，避免长度差异泄露信息） */
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
    const hb = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function splitList(v) {
    return String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function createSecurity(opts = {}) {
    const pick = (k, dflt) => (opts[k] !== undefined ? opts[k] : dflt);

    const token = String(pick('token', process.env.API_TOKEN || '')).trim();
    const ratePerMin = Number(pick('ratePerMin', process.env.RATE_LIMIT_PER_MIN || 120));
    const auditLimit = Math.max(10, Number(pick('auditLimit', process.env.AUDIT_LIMIT || 500)));
    const corsOrigin = pick('corsOrigin', process.env.CORS_ORIGIN || '');
    const headersOn = String(pick('securityHeaders', process.env.SECURITY_HEADERS || 'on')).toLowerCase() !== 'off';
    const allowedExt = splitList(pick('allowedExt', process.env.UPLOAD_ALLOWED_EXT
        || 'jpg,jpeg,png,webp,gif,bmp,mp4,webm,mov,pdf'));
    const maxUploadMb = Number(pick('maxUploadMb', process.env.UPLOAD_MAX_MB || 50));

    const tokenEnabled = token.length > 0;
    const capacity = Number.isFinite(ratePerMin) && ratePerMin > 0 ? Math.floor(ratePerMin) : 120;
    const refillPerMs = capacity / 60000;

    // ---- 令牌桶（按来源 IP 计数）----
    const buckets = new Map();
    function takeToken(ip) {
        const now = Date.now();
        let b = buckets.get(ip);
        if (!b) { b = { tokens: capacity, ts: now }; buckets.set(ip, b); }
        b.tokens = Math.min(capacity, b.tokens + (now - b.ts) * refillPerMs);
        b.ts = now;
        if (b.tokens < 1) {
            const needMs = Math.ceil((1 - b.tokens) / refillPerMs);
            return { ok: false, retryAfterMs: needMs };
        }
        b.tokens -= 1;
        // 惰性清理：桶数过多时丢弃 5 分钟未活动的条目
        if (buckets.size > 2048) {
            for (const [k, v] of buckets) if (now - v.ts > 300000) buckets.delete(k);
        }
        return { ok: true };
    }

    // ---- 审计环形缓冲 ----
    const audit = [];
    let auditSeq = 0;
    const counters = { total: 0, ok: 0, clientError: 0, serverError: 0, unauthorized: 0, rateLimited: 0 };

    function record(entry) {
        auditSeq += 1;
        counters.total += 1;
        if (entry.status >= 500) counters.serverError += 1;
        else if (entry.status === 401) counters.unauthorized += 1;
        else if (entry.status === 429) counters.rateLimited += 1;
        else if (entry.status >= 400) counters.clientError += 1;
        else counters.ok += 1;
        audit.push(Object.assign({ seq: auditSeq }, entry));
        if (audit.length > auditLimit) audit.splice(0, audit.length - auditLimit);
    }

    function clientIp(req) {
        return (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
    }

    function extractToken(req) {
        const h = req.headers || {};
        if (h['x-api-token']) return h['x-api-token'];
        const auth = String(h['authorization'] || '');
        const m = /^Bearer\s+(.+)$/i.exec(auth);
        return m ? m[1].trim() : '';
    }

    // ---- 安全响应头 ----
    // CSP 默认策略按当前前端（Vite 打包、无内联脚本、Element Plus 运行时注入 <style>）收敛：
    //   script-src 'self'           —— 只允许同源打包脚本
    //   style-src  'unsafe-inline'  —— Element Plus / ECharts 会注入行内样式
    //   connect-src ws: wss:        —— Socket.IO 同源连接
    // 如需接入 CDN 或监控脚本，用 CSP_POLICY 覆盖整条策略串。
    const cspPolicy = pick('cspPolicy', process.env.CSP_POLICY || [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'self'",
    ].join('; '));

    /** Express 中间件：写接口令牌校验 + 频率限制 + 审计 + 安全响应头 */
    function middleware() {
        return function securityMiddleware(req, res, next) {
            const start = Date.now();
            const ip = clientIp(req);
            const isMutating = MUTATING_METHODS.has(req.method);

            if (headersOn) {
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.setHeader('Referrer-Policy', 'no-referrer');
                res.setHeader('X-Frame-Options', 'DENY');
                res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
                if (cspPolicy) res.setHeader('Content-Security-Policy', cspPolicy);
            }

            res.on('finish', () => {
                if (!isMutating) return; // 只审计写操作，避免只读轮询刷爆缓冲
                record({
                    at: new Date(start).toISOString(),
                    ip,
                    method: req.method,
                    path: req.originalUrl || req.url,
                    status: res.statusCode,
                    ms: Date.now() - start,
                    ua: String((req.headers && req.headers['user-agent']) || '').slice(0, 80)
                });
            });

            if (!isMutating) return next();

            // 登录接口不参与令牌校验与写限流（否则开启 API_TOKEN 后无法登录）
            if ((req.path || '').startsWith('/api/auth/')) return next();

            if (tokenEnabled && !safeEqual(extractToken(req), token)) {
                res.status(401).json({ error: '未授权：写操作需要 API 令牌', hint: '请求头需带 X-API-Token 或 Authorization: Bearer <token>' });
                return;
            }

            const rl = takeToken(ip);
            if (!rl.ok) {
                res.setHeader('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
                res.status(429).json({ error: '写操作过于频繁，请稍后重试', retryAfterMs: rl.retryAfterMs });
                return;
            }

            next();
        };
    }

    /** GET /api/v2/audit —— 审计记录与安全状态 */
    function auditHandler() {
        return function (req, res) {
            const limit = Math.min(Math.max(Number((req.query || {}).limit) || 50, 1), auditLimit);
            res.json({
                limit,
                counters,
                list: audit.slice(-limit).reverse()
            });
        };
    }

    function status() {
        return {
            tokenEnabled,
            rateLimitPerMin: capacity,
            auditLimit,
            auditCount: audit.length,
            corsOrigin: corsOrigin ? splitList(corsOrigin) : '不限（保持原行为）',
            securityHeaders: headersOn,
            uploadAllowedExt: allowedExt,
            uploadMaxMb: maxUploadMb
        };
    }

    function corsOptions() {
        const list = splitList(corsOrigin);
        return list.length ? { origin: list } : {};
    }

    /** multer fileFilter：按扩展名白名单放行 */
    function uploadFilter() {
        return function (req, file, cb) {
            const name = String(file.originalname || '');
            const ext = (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '').toLowerCase();
            if (!allowedExt.length || allowedExt.includes(ext)) return cb(null, true);
            cb(new Error(`不支持的文件类型 .${ext}（允许：${allowedExt.join(', ')}）`));
        };
    }

    return {
        middleware,
        auditHandler,
        status,
        corsOptions,
        uploadFilter,
        uploadLimits: () => ({ fileSize: Math.max(1, maxUploadMb) * 1024 * 1024 }),
        tokenEnabled,
        capacity
    };
}

module.exports = { createSecurity, safeEqual, MUTATING_METHODS };
