/**
 * tests/helpers.js —— 集成测试/E2E 共用的启动与等待工具
 *
 * 设计取舍：
 *   · 用「子进程跑真实 server.js」而不是把 app 抽出来 export —— 测试覆盖的是
 *     真实启动路径（含 .env 加载、静态托管、Socket.IO、pipeline 初始化），
 *     这是冒烟测试（只挂 router）覆盖不到的部分。
 *   · 子进程强制 DATABASE_URL=''（process.loadEnvFile 不覆盖已有变量），
 *     因此测试不碰现网 MySQL，全部走内存 + 临时运行态文件。
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 启动被测服务
 * @param {object} [opts]
 * @param {number} [opts.port=3191]
 * @param {object} [opts.env] 额外环境变量
 * @returns {Promise<{child:import('child_process').ChildProcess, base:string, stateFile:string, stop:Function, logs:()=>string}>}
 */
async function startServer(opts = {}) {
    const port = Number(opts.port || 3191);
    const base = `http://127.0.0.1:${port}`;
    const stateFile = opts.stateFile
        || path.join(os.tmpdir(), `rt-state-${process.pid}-${Date.now()}.json`);
    const snapshotDir = opts.snapshotDir
        || path.join(os.tmpdir(), `rt-snap-${process.pid}-${Date.now()}`);

    const env = Object.assign({}, process.env, {
        PORT: String(port),
        PLC_MODE: 'simulation',
        DATABASE_URL: '',
        RUNTIME_STATE_FILE: stateFile,
        RUNTIME_SNAPSHOT_DIR: snapshotDir,
        SEED_DEMO_WARNINGS: 'true',
        ALLOW_SIM_FALLBACK: 'true',
        WS_SENSOR_MODE: 'subscribe',      // 固定投递方式，避免受 .env 影响
        CLOCK_DISABLED: 'true',          // 离线环境不依赖外网 DST
        LOG_LEVEL: 'quiet',
    }, opts.env || {});

    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(String(d)));
    child.stderr.on('data', (d) => chunks.push(String(d)));

    const stop = async ({ keepState = false } = {}) => {
        try { child.kill(); } catch { /* 已退出 */ }
        await sleep(250);
        if (keepState) return;
        try { fs.unlinkSync(stateFile); } catch { /* 不存在 */ }
        try { fs.rmSync(snapshotDir, { recursive: true, force: true }); } catch { /* 不存在 */ }
    };

    // 就绪探测：/api/health 能返回 ok 即认为启动完成
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            await stop();
            throw new Error(`服务提前退出（code=${child.exitCode}）：\n${chunks.join('')}`);
        }
        try {
            const r = await fetch(`${base}/api/health`);
            if (r.ok) {
                const body = await r.json();
                if (body && body.ok) return { child, base, stateFile, snapshotDir, stop, logs: () => chunks.join('') };
            }
        } catch { /* 还没起来 */ }
        await sleep(250);
    }
    await stop();
    throw new Error(`服务 20 s 内未就绪：\n${chunks.join('')}`);
}

/** 轮询直到 fn 返回真值（或超时抛错） */
async function waitFor(fn, { timeout = 8000, interval = 100, label = '条件' } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        try {
            last = await fn();
            if (last) return last;
        } catch (e) { last = e.message; }
        await sleep(interval);
    }
    throw new Error(`等待超时：${label}（最后结果：${JSON.stringify(last)}）`);
}

/** 简易断言器（与项目现有测试脚本风格一致，不引入框架） */
function createChecker() {
    let pass = 0, fail = 0;
    const failures = [];
    const chk = (name, cond, info) => {
        if (cond) { pass += 1; console.log(`  PASS  ${name}${info ? '  ' + info : ''}`); }
        else {
            fail += 1;
            failures.push(name);
            console.log(`  FAIL  ${name}${info ? '  ' + info : ''}`);
        }
        return !!cond;
    };
    const summary = (title) => {
        console.log(`\n==== ${title}：PASS ${pass} / FAIL ${fail} ====`);
        if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '));
        return fail === 0;
    };
    return { chk, summary, get fail() { return fail; }, get pass() { return pass; } };
}

module.exports = { ROOT, sleep, startServer, waitFor, createChecker };
