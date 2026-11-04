/**
 * miss_side.js —— 漏报侧校核、25 h 稳态、Wilson 覆盖率、权重扰动 重新生成（论文12.7 口径）
 *
 * 口径：
 *   §4.4 漏报侧：500 次 × 20 min 独立试验（每次独立冷启动），速率 1.5/2/2.5/3/5/10 ℃·min⁻¹；
 *     检测器 = 平台 EWMA 管线（3 点中值 → EWMA λ=0.2 → roc=Z_t−Z_{t−60} ≥ 2.0 ℃·min⁻¹，连续 2 点确认）
 *     + 80 ℃ 阈值通道；白噪声 σ=1.0 ℃，基线 25 ℃；输出检出率与检出时延中位数、90 分位。
 *   §4.4 25 h 稳态：90 000 s 纯噪声，启用 15 s 冷启动保护（误报率评估类口径）；0 条的上界按
 *     rule-of-three 给出 3/25 = 0.12 次/h。
 *   §4.3 Wilson 覆盖率：200 次 × 5 000 帧（2 s 轮询）独立丢包信道，真值 1%~50%，
 *     式(11) Wilson 95%CI，覆盖率 = 区间包含真值的试验占比。
 *   §4.5 权重扰动：式(7) 四系数 k={0.5,0.8,2.5,2.5} 全部 16 种 ±20% 符号组合，
 *     表15 七行中检修等级发生改变的行数（平台 maintenance.js 同一实现）。
 * 全部固定种子，可复现。
 */
'use strict';

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function med3(a, b, c) { return a + b + c - Math.max(a, b, c) - Math.min(a, b, c); }

const SIG = 1.0, LAM = 0.2, W = 60, ROC_WARN = 2.0, TEMP_HIGH = 80, BASE = 25;

/** 平台 EWMA 检测器（1 Hz）：返回告警事件 1/0 */
function makeEwmaDet() {
    let bm = [], Z = BASE, hist = [], p1 = false;
    return (x) => {
        bm.push(x); if (bm.length > 3) bm.shift();
        const m = bm.length === 3 ? med3(bm[0], bm[1], bm[2]) : x;
        Z = LAM * m + (1 - LAM) * Z;
        hist.push(Z); if (hist.length > W + 1) hist.shift();
        const overRoc = hist.length === W + 1 && (Z - hist[0]) >= ROC_WARN;
        const overThr = x >= TEMP_HIGH;
        const a = (overRoc && p1) || overThr;
        p1 = overRoc;
        return a ? 1 : 0;
    };
}

// ---------- §4.4 漏报侧 ----------
function missSide() {
    console.log('=== §4.4 漏报侧校核（500 次 × 20 min，σ=1.0 ℃，基线 25 ℃） ===');
    console.log('  速率      | 检出率   | 时延中位(s) | 时延90分位(s) | 未检出');
    const RATES = [1.5, 2, 2.5, 3, 5, 10];
    const res = [];
    for (const rate of RATES) {
        const lats = [];
        let det = 0;
        for (let trial = 0; trial < 500; trial++) {
            const r = rng(20261018 + Math.round(rate * 10) + trial * 7);
            const d = makeEwmaDet();
            let T = BASE, found = null;
            for (let t = 0; t < 1200; t++) {
                if (d(T + gauss(r) * SIG) === 1) { found = t; break; }
                T += rate / 60;
            }
            if (found !== null) { det++; lats.push(found); }
        }
        lats.sort((a, b) => a - b);
        const med = lats.length ? lats[Math.floor(lats.length / 2)] : '—';
        const p90 = lats.length ? lats[Math.floor(lats.length * 0.9)] : '—';
        res.push({ rate, detRate: (det / 5).toFixed(1) + '%', med, p90 });
        console.log(`  ${String(rate).padStart(4)} ℃/min | ${String((det / 5).toFixed(1) + '%').padStart(6)} | ${String(med).padStart(9)} | ${String(p90).padStart(12)} | ${500 - det}`);
    }
    return res;
}

// ---------- §4.4 25 h 稳态 ----------
function steady25h() {
    console.log('\n=== §4.4 25 h 稳态（90 000 s 纯噪声，15 s 冷启动保护开启） ===');
    const r = rng(20261018 + 25);
    const d = makeEwmaDet();
    let alarms = 0;
    // 冷启动保护：差分基准不得早于引擎启动后 15 s → 首个有效 roc 在 t = 75 s
    for (let t = 0; t < 90000; t++) {
        const x = BASE + gauss(r) * SIG;
        const a = d(x);
        if (t >= 75 && a === 1) alarms++;
    }
    console.log(`  告警条数 = ${alarms} 条；0 条时 95% 单侧上界 = 3/25 = 0.12 次/h（rule of three）`);
    return alarms;
}

// ---------- §4.3 Wilson 覆盖率 ----------
function wilsonCoverage() {
    console.log('\n=== §4.3 Wilson 覆盖率（200 次 × 5 000 帧，95%CI，式(11)） ===');
    const { LinkMonitor } = require('../../link-monitor.js');
    const PS = [0.01, 0.02, 0.05, 0.10, 0.20, 0.30, 0.40, 0.50];
    const covs = [];
    for (const p of PS) {
        let covered = 0;
        for (let trial = 0; trial < 200; trial++) {
            const r = rng(20261018 + 43 + Math.round(p * 1000) + trial * 11);
            const lm = new LinkMonitor();
            for (let i = 0; i < 5000; i++) {
                if (r() < p) continue;                       // 独立丢包
                lm.onPacket({ t: i * 2000, seq: (i % 65535) + 1 });
            }
            const ci = lm.stats().lossCI;
            if (ci.lo <= p && p <= ci.hi) covered++;
        }
        const c = covered / 200 * 100;
        covs.push(c);
        console.log(`  真值 p = ${String((p * 100).toFixed(0) + '%').padStart(4)} → 覆盖率 ${c.toFixed(1)}%`);
    }
    const lo = Math.min(...covs), hi = Math.max(...covs);
    console.log(`  覆盖率范围：${lo.toFixed(1)}% ~ ${hi.toFixed(1)}%`);
    return { lo, hi };
}

// ---------- §4.5 权重扰动 ----------
function weightPerturb() {
    console.log('\n=== §4.5 权重 ±20% 扰动（式(7) 四系数，16 种符号组合 × 表15 七行） ===');
    const { MaintenanceService } = require('../../maintenance.js');
    const rows = [
        [0, 0, 25, 0], [5, 3, 30, 1], [15, 8, 45, 2], [25, 12, 60, 4],
        [40, 20, 78, 8], [60, 30, 85, 12], [100, 40, 100, 20],
    ];
    const keys = ['kForce', 'kWave', 'kTemp', 'kAlarm'];
    const base = { kForce: 0.5, kWave: 0.8, kTemp: 2.5, kAlarm: 2.5 };
    const nominal = rows.map(([dev, sd, tmax, n24]) =>
        new MaintenanceService().healthIndex({ forceMean: 100 + dev, forceTarget: 100, forceStd: sd, tempMax: tmax, alarmCount24h: n24 }).grade);
    let changed = 0;
    for (let i = 0; i < rows.length; i++) {
        const [dev, sd, tmax, n24] = rows[i];
        let any = false, firstG = null;
        for (let combo = 0; combo < 16; combo++) {
            const cfg = {};
            for (let j = 0; j < 4; j++) cfg[keys[j]] = base[keys[j]] * ((combo >> j) & 1 ? 1.2 : 0.8);
            const g = new MaintenanceService(cfg).healthIndex({ forceMean: 100 + dev, forceTarget: 100, forceStd: sd, tempMax: tmax, alarmCount24h: n24 }).grade;
            if (g !== nominal[i]) { if (!any) firstG = g; any = true; }
        }
        if (any) { changed++; console.log(`  行 ${i + 1}（${nominal[i]}）在 16 种组合下出现等级变化（首个变化组合 → ${firstG}）`); }
    }
    console.log(`  等级改变行数 = ${changed} / 7（${(changed / 7 * 100).toFixed(0)}%）`);
    return changed;
}

missSide();
steady25h();
wilsonCoverage();
weightPerturb();
