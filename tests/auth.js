/**
 * tests/auth.js —— 认证与角色集成测试（独立子进程，AUTH_ENABLED=true）
 *
 * 覆盖：未登录拒绝、错误密码、operator 可写、viewer 只读、登出失效、健康接口公开。
 * 显式设 AUTH_PUBLIC_READ=false，让“未登录连读都不行”这条也能被断言到。
 */

'use strict';

const { startServer, createChecker } = require('./helpers');

const PORT = Number(process.env.AUTH_TEST_PORT || 3194);

function cookieOf(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return list.length ? list[0].split(';')[0] : '';
}

(async () => {
    const { chk, summary } = createChecker();
    let srv = null;

    try {
        srv = await startServer({
            port: PORT,
            env: {
                AUTH_ENABLED: 'true',
                AUTH_OPERATOR_USER: 'op',
                AUTH_OPERATOR_PASS: 'op-pass-123',
                AUTH_VIEWER_USER: 'vw',
                AUTH_VIEWER_PASS: 'vw-pass-123',
                AUTH_SECRET: 'fixed-test-secret',
                AUTH_PUBLIC_READ: 'false',
            },
        });
        const base = srv.base;

        const req = async (p, { method = 'GET', body, cookie } = {}) => {
            const headers = {};
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            if (cookie) headers.Cookie = cookie;
            const res = await fetch(base + p, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            let json = null;
            try { json = await res.json(); } catch { /* 非 JSON */ }
            return { status: res.status, body: json, cookie: cookieOf(res) };
        };

        console.log('==== 认证与角色（AUTH_ENABLED=true）====');

        // 公开接口
        let r = await req('/api/health');
        chk('健康检查无需登录（供探针）', r.status === 200 && r.body.auth && r.body.auth.enabled === true, `auth=${JSON.stringify(r.body.auth && r.body.auth.enabled)}`);

        r = await req('/api/auth/me');
        chk('/api/auth/me 未登录时 enabled=true、user=null', r.status === 200 && r.body.enabled === true && r.body.user === null, JSON.stringify(r.body));

        // 未登录
        r = await req('/api/history');
        chk('未登录读取被拒绝（401 + AUTH_REQUIRED）', r.status === 401 && r.body.code === 'AUTH_REQUIRED', `${r.status} ${r.body && r.body.code}`);

        r = await req('/api/alert', { method: 'POST', body: { alarmType: '燃弧超限', code: 'A-1' } });
        chk('未登录写入被拒绝（401）', r.status === 401, String(r.status));

        // 错误密码
        r = await req('/api/auth/login', { method: 'POST', body: { username: 'op', password: 'wrong' } });
        chk('错误密码返回 401', r.status === 401, String(r.status));

        // operator
        const opLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'op', password: 'op-pass-123' } });
        chk('operator 登录成功并下发 Cookie', opLogin.status === 200 && opLogin.body.user.role === 'operator' && !!opLogin.cookie, opLogin.body.user && opLogin.body.user.role);
        const opCookie = opLogin.cookie;

        r = await req('/api/history', { cookie: opCookie });
        chk('operator 可读取数据', r.status === 200, String(r.status));

        r = await req('/api/alert', { method: 'POST', cookie: opCookie, body: { alarmType: '导高超限', code: 'A-2', worker: 'WX-1' } });
        chk('operator 可执行写操作', r.status === 200 && r.body.success === true, `${r.status}`);

        // viewer
        const vwLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'vw', password: 'vw-pass-123' } });
        chk('viewer 登录成功', vwLogin.status === 200 && vwLogin.body.user.role === 'viewer', vwLogin.body.user && vwLogin.body.user.role);
        const vwCookie = vwLogin.cookie;

        r = await req('/api/history', { cookie: vwCookie });
        chk('viewer 可读取数据', r.status === 200, String(r.status));

        r = await req('/api/alert', { method: 'POST', cookie: vwCookie, body: { alarmType: '导高超限', code: 'A-3' } });
        chk('viewer 写操作被拒绝（403 AUTH_FORBIDDEN）', r.status === 403 && r.body.code === 'AUTH_FORBIDDEN', `${r.status} ${r.body && r.body.code}`);

        // 登出
        await req('/api/auth/logout', { method: 'POST', cookie: vwCookie });
        r = await req('/api/history', { cookie: vwCookie });
        chk('登出后读取恢复 401', r.status === 401, String(r.status));

        // 状态汇总
        r = await req('/api/health');
        chk('health 暴露账号与拦截计数', r.body.auth.accounts.length === 2 && typeof r.body.auth.denied === 'number',
            `accounts=${r.body.auth.accounts.length} denied=${r.body.auth.denied}`);

    } catch (err) {
        console.error('❌ 认证测试异常:', err.message);
        if (srv) console.error(srv.logs().slice(-3000));
        process.exitCode = 1;
    } finally {
        if (srv) await srv.stop();
        if (!summary('认证测试汇总')) process.exitCode = 1;
    }
})();
