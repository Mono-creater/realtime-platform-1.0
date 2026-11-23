#!/usr/bin/env node
/**
 * sync-camera-time.js —— camhiPro 相机校时 / 画面方向修正（零依赖，Node >= 18）
 *
 * 背景：该相机 NTP 默认指到 ntp.main（不可达），且断网重启后 RTC 会退回 2025-01-10；
 *       OSD 水印烧进画面后无法修改，取证前必须把时间与方向弄对。
 *
 * 用法：
 *   node sync-camera-time.js                 # 校时 + 读回确认
 *   node sync-camera-time.js --read          # 只读当前时间与图像属性
 *   node sync-camera-time.js --flip on       # 画面翻转（on/off）
 *   node sync-camera-time.js --ip 192.168.1.89 --user admin --pass 12345678a
 *
 * 环境变量：CAM1_IP / CAM1_USER / CAM1_PASS（与 tools/图传/.env 同名）
 * 说明：相机 NTP 客户端必须关闭（脚本自动关），否则手动校时会被 NTP 覆盖。
 */
'use strict';

const fs = require('fs');
const path = require('path');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    if (i === -1) return def;
    const v = process.argv[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
}

const envFile = path.join(__dirname, '.env');
const env = {};
if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}
const IP = String(arg('--ip', process.env.CAM1_IP || env.CAM1_IP || '192.168.1.88'));
const USER = String(arg('--user', process.env.CAM1_USER || env.CAM1_USER || 'admin'));
const PASS = String(arg('--pass', process.env.CAM1_PASS || env.CAM1_PASS || '12345678a'));
const FLIP = arg('--flip', null);
const READ_ONLY = arg('--read', false) === true;

const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const API = (q) => `http://${IP}/cgi-bin/hi3510/param.cgi?${q}`;
const get = async (q) => {
    const r = await fetch(API(q), { headers: { Authorization: AUTH }, signal: AbortSignal.timeout(6000) });
    return r.text();
};
const put = async (q) => {
    const r = await fetch(API(q), { headers: { Authorization: AUTH }, signal: AbortSignal.timeout(6000) });
    return { status: r.status, text: (await r.text()).slice(0, 120) };
};
const pad = (n) => String(n).padStart(2, '0');

(async () => {
    const info = await get('cmd=getservertime');
    const camTime = (info.match(/time="(\d+)"/) || [])[1] || '?';
    const fmt = (t) => (t.length === 14 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}` : t);

    if (READ_ONLY) {
        const img = await get('cmd=getimageattr');
        console.log(`相机 ${IP}  时间 ${fmt(camTime)}  flip=${(img.match(/flip="(\w+)"/) || [])[1]}  mirror=${(img.match(/mirror="(\w+)"/) || [])[1]}`);
        return;
    }

    if (FLIP !== null) {
        const v = FLIP === true ? 'on' : FLIP;
        const r = await put(`cmd=setimageattr&-flip=${v}`);
        const img = await get('cmd=getimageattr');
        console.log(`[翻转] ${r.status} ${r.text.trim()} → flip=${(img.match(/flip="(\w+)"/) || [])[1]} mirror=${(img.match(/mirror="(\w+)"/) || [])[1]}`);
    }

    // 1) 关 NTP（默认 ntpserver=ntp.main 不可达，会把手动校时顶回去）
    const ntp = await put('cmd=setntpattr&-ntpenable=0');
    console.log(`[NTP ] ${ntp.status} ${ntp.text.trim()}`);

    // 2) 校时：字段名必须是 -time，格式 YYYY.MM.DD.HH.MM.SS（-stime 无效，设备仍回 set ok）
    const d = new Date(Date.now() + 8 * 3600e3);
    const stime = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}.${pad(d.getUTCHours())}.${pad(d.getUTCMinutes())}.${pad(d.getUTCSeconds())}`;
    const set = await put(`cmd=setservertime&-time=${encodeURIComponent(stime)}&-timezone=Asia/Hong_Kong&-dstmode=off`);
    console.log(`[校时] ${set.status} ${set.text.trim()}  目标 ${stime}`);

    await new Promise((r) => setTimeout(r, 1200));
    const after = await get('cmd=getservertime');
    const now = (after.match(/time="(\d+)"/) || [])[1] || '?';
    const drift = Number(now) - Number(stime.replace(/\./g, ''));
    console.log(`[回读] ${fmt(now)}  ${Math.abs(drift) <= 5 ? '✔ 已对齐' : '✘ 未生效（差 ' + drift + '）'}`);
})();
