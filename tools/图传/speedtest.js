#!/usr/bin/env node
/**
 * 4G/5G 上行测速：上传 N MB 到平台 /api/speedtest，报上行 Mbps
 *
 * 依赖：Node >= 18（原生 fetch），无需 ffmpeg。
 * 用法：
 *   node speedtest.js 20       上传 20MB 测一次
 *   node speedtest.js 50 3     上传 50MB 测 3 次
 *
 * 配置：改环境变量或直接用默认值。
 *   SPEEDTEST_URL  测速端点，默认 <PLATFORM_URL 去尾>/api/speedtest
 *   PLATFORM_URL   平台上传地址（默认 http://192.168.1.50:3000/api/upload-alarm）
 *   API_TOKEN      平台开启 AUTH 时填
 *
 * 建议：4G/5G 波动大，测 3~5 次取「最低值」作为设计依据（不是平均值）。
 */
try { process.loadEnvFile(); } catch { /* 无 .env 忽略 */ }

const MB = Math.max(1, Number(process.argv[2]) || 20);
const TIMES = Math.max(1, Number(process.argv[3]) || 1);

const platform = process.env.PLATFORM_URL || 'http://192.168.1.50:3000/api/upload-alarm';
const base = platform.replace(/\/api\/upload-alarm\/?$/, '');
const url = process.env.SPEEDTEST_URL || `${base}/api/speedtest`;
const token = process.env.API_TOKEN || '';

const headers = { 'Content-Type': 'application/octet-stream' };
if (token) headers['X-API-Token'] = token;

// 1 MiB 块，重复 N 次拼成 N MB（一次性放入内存，20~50MB 无压力）
const chunk = Buffer.alloc(1024 * 1024, 0x5a);
const body = Buffer.concat(Array.from({ length: MB }, () => chunk));

console.log(`测速端点: ${url}`);
console.log(`数据量: ${MB} MB × ${TIMES} 次\n`);

let min = Infinity;
for (let i = 1; i <= TIMES; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'POST', headers, body });
    const t1 = Date.now();
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    const sec = (t1 - t0) / 1000;
    const mbps = (body.length * 8) / sec / 1e6;
    min = Math.min(min, mbps);
    console.log(`第${i}次：上传 ${MB}MB 用时 ${(t1 - t0)} ms → 上行 ${mbps.toFixed(2)} Mbps`);
  } catch (e) {
    console.error(`第${i}次失败: ${e.message}`);
  }
}

if (TIMES > 1 && min !== Infinity) console.log(`\n最低上行：${min.toFixed(2)} Mbps`);

// 设计阈值参考
console.log('\n—— 阈值参考（按最低值）——');
console.log('  < 1 Mbps   : 视频切片(10MB)需 >80s，只能回库补传；实时预览不可用');
console.log('  1~3 Mbps   : 切片可后台慢传；实时预览勉强（720p@1Mbps 无余量）');
console.log('  > 3 Mbps   : 视频可边跑边传；实时预览(子码流)可行');
