/**
 * methods_bench.js —— 表9 六方法对照重新生成（论文12.7 口径）
 *
 * 口径（对应论文 4.4 节表 9 与 L729-738、L1158-1162）：
 *   - 判决限按 1 Hz 逐样本判决口径、经 420 d 噪声仿真校准至误报率 0.01 次/h（ARL₀ ≈ 100 h）；
 *   - 尖峰工况：300 次 × 300 s 独立试验（每次独立冷启动），共注入 1 750 个 +8 ℃ 单点尖峰；
 *   - 检出时延：30 次独立试验中位数；观测上限 3 600 s；速率 2/3/5/10 ℃·min⁻¹；
 *   - 白噪声 σ = 1.0 ℃；温度基线 25 ℃。
 * 六种方法（判决统计量与单位）：
 *   ① 原始差分：|x_t−x_{t−1}|（℃·s⁻¹），连续 2 点确认；
 *   ② 中值差分：med3_t−med3_{t−1}（℃·s⁻¹），单侧（正），连续 2 点确认；
 *   ③ 时间窗投票：|差分| 超限计数，Tvote=30 s、ρ=0.8、nmin=2（窗口级判决）；
 *   ④ EWMA（本文）：λ=0.2、W=60 s，roc=(Z_t−Z_{t−60}) ℃·min⁻¹，逐样本单点判决
 *      （论文 L1160：表 9 本文行 60 s 与表 10 的 61 s 相差恰为一个确认步）；
 *   ⑤ OLS：60 s 滑窗最小二乘斜率 β（℃·min⁻¹），连续 2 点确认；
 *   ⑥ CUSUM：S_t=max(0, S_{t−1}+x_t−25−k)，k=0.5 ℃，S>h 告警后复位。
 * 全部固定种子，可复现。输出即论文表 9 的新权威数值。
 */
'use strict';

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function med3(a, b, c) { return a + b + c - Math.max(a, b, c) - Math.min(a, b, c); }

const SIG = 1.0, LAM = 0.2, W = 60;
const FAR_H = 0.01;                          // 0.01 次/h（ARL₀≈100 h）
const P_SAMPLE = FAR_H / 3600;               // 每样本位置虚警率
const CALIB_DAYS = 420, CALIB_N = CALIB_DAYS * 86400;
const VOTE_T = 30, VOTE_RHO = 0.8, VOTE_NMIN = 2;
const VOTE_NEED = Math.max(VOTE_NMIN, Math.ceil(VOTE_RHO * VOTE_T));
const CUSUM_K = 0.5;

/**
 * 栅格标定器：一次长跑内对 8 个候选判决限并行计数告警事件，最后对数线性插值到目标率。
 * kind: 'twoSideConfirm' 双侧+连续2点 | 'oneSideConfirm' 单侧+连续2点 | 'vote' 窗口投票 | 'single' 单点双侧 | 'cusum'
 */
function makeGridCalib(grid, kind) {
    return {
        grid, kind,
        events: grid.map(() => 0),
        prev: grid.map(() => false),
        voteHits: grid.map(() => 0),
        voteBuf: grid.map(() => new Array(VOTE_T).fill(false)),
        votePos: 0,
        cusumS: grid.map(() => 0),
        update(v) {
            for (let i = 0; i < this.grid.length; i++) {
                const thr = this.grid[i];
                switch (this.kind) {
                    case 'twoSideConfirm': {
                        const over = Math.abs(v) > thr;
                        if (over && this.prev[i]) this.events[i]++;
                        this.prev[i] = over; break;
                    }
                    case 'oneSideConfirm': {
                        const over = v > thr;
                        if (over && this.prev[i]) this.events[i]++;
                        this.prev[i] = over; break;
                    }
                    case 'single': if (Math.abs(v) > thr) this.events[i]++; break;
                    case 'vote': {
                        const b = this.voteBuf[i];
                        const over = Math.abs(v) > thr;
                        if (b[this.votePos]) this.voteHits[i]--;
                        b[this.votePos] = over;
                        if (over) this.voteHits[i]++;
                        if (this.voteHits[i] >= VOTE_NEED) this.events[i]++;
                        break;
                    }
                    case 'cusum': {
                        this.cusumS[i] = Math.max(0, this.cusumS[i] + (v - 25 - CUSUM_K));
                        if (this.cusumS[i] > thr) { this.events[i]++; this.cusumS[i] = 0; }
                        break;
                    }
                }
            }
            if (this.kind === 'vote') this.votePos = (this.votePos + 1) % VOTE_T;
        },
        rate(i) { return this.events[i] / CALIB_N; },
        solve() {
            const r = this.grid.map((_, i) => this.rate(i));
            for (let i = 0; i < r.length - 1; i++) {
                if (r[i] >= P_SAMPLE && r[i + 1] <= P_SAMPLE && r[i] > 0 && r[i + 1] > 0) {
                    const f = (Math.log(P_SAMPLE) - Math.log(r[i])) / (Math.log(r[i + 1]) - Math.log(r[i]));
                    return this.grid[i] + f * (this.grid[i + 1] - this.grid[i]);
                }
            }
            return null;
        },
    };
}

// ---------- 420 d 校准 ----------
function calibrate() {
    const gRaw = makeGridCalib([2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0], 'twoSideConfirm');   // ℃/s
    const gMed = makeGridCalib([0.6, 0.9, 1.2, 1.5, 1.8, 2.1, 2.4, 2.7], 'oneSideConfirm');   // ℃/s
    const gVote = makeGridCalib([0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2], 'vote');           // ℃/s
    const gEwma = makeGridCalib([1.6, 2.0, 2.4, 2.8, 3.2, 3.6, 4.0, 4.4], 'single');         // ℃/min
    const gOls = makeGridCalib([1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4], 'twoSideConfirm');  // ℃/min
    const gCusum = makeGridCalib([9, 10, 11, 12, 13, 14, 15, 16], 'cusum');                  // ℃

    const r = rng(20261018);
    let px = 25, pm = 25, Z = 25;
    const bm = [], hist = [], bOls = [];
    let sy = 0, sxy = 0;
    const XS = (W * (W - 1)) / 2, XS2 = (W * (W - 1) * (2 * W - 1)) / 6;

    for (let i = 0; i < CALIB_N; i++) {
        const x = 25 + gauss(r) * SIG;
        const d = x - px; px = x;
        bm.push(x); if (bm.length > 3) bm.shift();
        const m = bm.length === 3 ? med3(bm[0], bm[1], bm[2]) : x;
        const md = m - pm; pm = m;
        Z = LAM * m + (1 - LAM) * Z;
        hist.push(Z); if (hist.length > W + 1) hist.shift();
        const roc = hist.length === W + 1 ? Z - hist[0] : 0;
        // OLS 滑动和：窗口相对索引 0..W−1，移位恒等式 sxy = sxy − sy + W·x（避免绝对索引大数相消）
        bOls.push(x);
        if (bOls.length > W) { const o = bOls.shift(); sy = sy - o + x; sxy = sxy - sy + W * x; }
        else { sy += x; sxy += (bOls.length - 1) * x; }
        const beta = bOls.length >= W ? (W * sxy - XS * sy) / (W * XS2 - XS * XS) * 60 : 0;

        gRaw.update(d); gMed.update(md); gVote.update(d);
        gEwma.update(roc); gOls.update(beta); gCusum.update(x);
    }
    const out = { thrRaw: gRaw.solve(), thrMed: gMed.solve(), thrVote: gVote.solve(), thrEwma: gEwma.solve(), thrOls: gOls.solve(), hCusum: gCusum.solve() };
    for (const [name, g, key] of [['raw', gRaw, 'thrRaw'], ['med', gMed, 'thrMed'], ['vote', gVote, 'thrVote'], ['ewma', gEwma, 'thrEwma'], ['ols', gOls, 'thrOls'], ['cusum', gCusum, 'hCusum']]) {
        if (out[key] === null) {
            console.log(`  [DEBUG] ${name} 未收敛，栅格事件率(×10⁶/样本): ${g.grid.map((_, i) => (g.rate(i) * 1e6).toExponential(1)).join(' ')}`);
        }
    }
    return out;
}

// ---------- 六方法运行时检测器（告警事件返回 1） ----------
function makeDet(m, thr) {
    if (m === 0) { // 原始差分：|d|，连续2点
        let px = 25, p1 = false;
        return (x) => { const over = Math.abs(x - px) > thr; px = x; const a = over && p1; p1 = over; return a ? 1 : 0; };
    }
    if (m === 1) { // 中值差分：单侧正，连续2点
        let b = [], pm = 25, p1 = false;
        return (x) => {
            b.push(x); if (b.length > 3) b.shift();
            const med = b.length === 3 ? med3(b[0], b[1], b[2]) : x;
            const over = med - pm > thr; pm = med;
            const a = over && p1; p1 = over; return a ? 1 : 0;
        };
    }
    if (m === 2) { // 时间窗投票
        let px = 25, hits = 0; const buf = new Array(VOTE_T).fill(false); let pos = 0;
        return (x) => {
            const over = Math.abs(x - px) > thr; px = x;
            if (buf[pos]) hits--;
            buf[pos] = over; if (over) hits++;
            pos = (pos + 1) % VOTE_T;
            return hits >= VOTE_NEED ? 1 : 0;
        };
    }
    if (m === 3) { // EWMA（本文）：单点
        let b = [], Z = 25, hist = [];
        return (x) => {
            b.push(x); if (b.length > 3) b.shift();
            const med = b.length === 3 ? med3(b[0], b[1], b[2]) : x;
            Z = LAM * med + (1 - LAM) * Z;
            hist.push(Z); if (hist.length > W + 1) hist.shift();
            if (hist.length < W + 1) return 0;
            return Math.abs(Z - hist[0]) > thr ? 1 : 0;
        };
    }
    if (m === 4) { // OLS：|β|，连续2点
        let b = [], p1 = false, sy = 0, sxy = 0;
        const XS = (W * (W - 1)) / 2, XS2 = (W * (W - 1) * (2 * W - 1)) / 6;
        return (x) => {
            b.push(x);
            if (b.length > W) { const o = b.shift(); sy = sy - o + x; sxy = sxy - sy + W * x; }
            else { sy += x; sxy += (b.length - 1) * x; }
            const over = b.length >= W && Math.abs((W * sxy - XS * sy) / (W * XS2 - XS * XS) * 60) > thr;
            const a = over && p1; p1 = over; return a ? 1 : 0;
        };
    }
    // m === 5: CUSUM
    let S = 0;
    return (x) => { S = Math.max(0, S + (x - 25 - CUSUM_K)); if (S > thr) { S = 0; return 1; } return 0; };
}

// ---------- 尖峰实验 ----------
function spikeRun(thrs) {
    const T = 300, N = 300, SPIKES = 1750;
    const r = rng(20261018 + 7);
    const spikePos = new Set();
    while (spikePos.size < SPIKES) spikePos.add(Math.floor(r() * N * T));
    const THR = [thrs.thrRaw, thrs.thrMed, thrs.thrVote, thrs.thrEwma, thrs.thrOls, thrs.hCusum];
    const counts = new Array(6).fill(0);
    for (let k = 0; k < N; k++) {
        const ds = THR.map((thr, m) => makeDet(m, thr));
        for (let t = 0; t < T; t++) {
            let x = 25 + gauss(r) * SIG;
            if (spikePos.has(k * T + t)) x += 8;
            for (let m = 0; m < 6; m++) if (ds[m](x) === 1) { counts[m]++; break; }
        }
    }
    return counts;
}

// ---------- 检出时延 ----------
function latencyRun(thrs) {
    const THR = [thrs.thrRaw, thrs.thrMed, thrs.thrVote, thrs.thrEwma, thrs.thrOls, thrs.hCusum];
    const RATES = [2, 3, 5, 10];
    const out = {};
    for (const rate of RATES) {
        const row = [];
        for (let m = 0; m < 6; m++) {
            const lats = [];
            for (let trial = 0; trial < 30; trial++) {
                const r = rng(20261018 + m * 100 + rate + trial * 3);
                const d = makeDet(m, THR[m]);
                let T0 = 25, found = null;
                for (let t = 0; t < 3600; t++) {
                    if (d(T0 + gauss(r) * SIG) === 1) { found = t; break; }
                    T0 += rate / 60;
                }
                lats.push(found === null ? 3601 : found);
            }
            lats.sort((a, b) => a - b);
            row.push(lats[15] >= 3601 ? '未检出' : lats[15]);
        }
        out[rate] = row;
    }
    return out;
}

// ---------- 主流程 ----------
console.log('=== 表9 重新生成（六方法，1 Hz 逐样本判决，校准至 0.01 次/h，ARL₀≈100 h） ===');
console.log('判决限校准中（420 d 噪声仿真，6 方法 × 8 候选判决限并行计数）…');
const t0 = Date.now();
const thrs = calibrate();
console.log(`  校准完成（${((Date.now() - t0) / 1000).toFixed(1)} s）`);
const L = thrs.thrEwma / 0.4714;
console.log('  判决限:');
console.log(`    原始差分   ${thrs.thrRaw.toFixed(2)} ℃·s⁻¹（|x_t−x_{t−1}|，连续2点确认）`);
console.log(`    中值差分   ${thrs.thrMed.toFixed(2)} ℃·s⁻¹（单侧正，连续2点确认）`);
console.log(`    时间窗投票 ${thrs.thrVote.toFixed(2)} ℃·s⁻¹（T=30 s、ρ=0.8、nmin=2）`);
console.log(`    EWMA(本文) ${thrs.thrEwma.toFixed(2)} ℃·min⁻¹（L = ${L.toFixed(2)}σr，σr=0.4714，单点判决）`);
console.log(`    OLS        ${thrs.thrOls.toFixed(2)} ℃·min⁻¹（60 s 滑窗，连续2点确认）`);
console.log(`    CUSUM      h = ${thrs.hCusum.toFixed(2)} ℃（k=0.5 ℃）`);

console.log('\n=== 尖峰实验（300 次 × 300 s，1 750 个 +8 ℃ 尖峰，告警条数） ===');
const spike = spikeRun(thrs);
console.log(`  原始差分 ${spike[0]} | 中值差分 ${spike[1]} | 时间窗投票 ${spike[2]} | EWMA(本文) ${spike[3]} | OLS ${spike[4]} | CUSUM ${spike[5]}`);

console.log('\n=== 检出时延（30 次独立试验中位，s；未检出 = 3 600 s 内无告警） ===');
const lat = latencyRun(thrs);
console.log('  速率      | 原始差分 | 中值差分 | 时间窗投票 | EWMA(本文) | OLS | CUSUM');
for (const [rate, row] of Object.entries(lat)) {
    console.log(`  ${String(rate).padStart(2)} ℃/min | ${row.join(' | ')}`);
}
