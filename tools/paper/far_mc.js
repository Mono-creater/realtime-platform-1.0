/**
 * far_mc.js —— 表11 判决限—误报率/ARL₀、§2.4 蒙特卡洛、表14 解耦 重新生成（论文12.7 口径）
 *
 * 口径：
 *   §2.4 蒙特卡洛：N = 3×10⁶ 白噪声样本（σ=1），x → EWMA(λ=0.2) → Z；roc = Z_t − Z_{t−60}（℃·min⁻¹）。
 *     输出：Var(Z)、Z 的自相关 r_Z(1)/r_Z(2)、3 点中值序列的自相关 r_m(1)/r_m(2)、σr 经验值。
 *   表11：roc 逐样本判决 |roc| ≥ L·σr（σr = 0.4714），N = 1×10⁸ 长跑计尾部越限 → 误报率（次/h）与 ARL₀ = 1/FAR_h；
 *     解析列 = 3600×2(1−Φ(L))（高斯近似，对应论文"解析"口径），复算列 = 蒙特卡洛（对应"复算"口径）。
 *   表14：解耦前窗口 = 固定样本条数 20 条 × 轮询周期 Δt（Δt ∈ {0.15, 0.5, 1.5} s → 等效窗口 3/10/30 s）；
 *     解耦后 = 按时间裁剪恒 60 s。σr = σ·√(2λ/(2−λ))/W_eff（W_eff 单位 min）。解析 + 长跑实测双栏。
 * 全部固定种子，可复现。
 */
'use strict';

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function med3(a, b, c) { return a + b + c - Math.max(a, b, c) - Math.min(a, b, c); }

const SIG = 1.0, LAM = 0.2, W = 60;   // W = 60 样本（1 Hz → 1 min）
const W_MIN = W / 60;                   // 式(6) 中 W 单位为 min
const SIGMA_R = SIG * Math.sqrt(2 * LAM / (2 - LAM)) / W_MIN; // 式(6) = 0.4714 ℃·min⁻¹

// ---------- §2.4 蒙特卡洛（N = 3×10⁶） ----------
function mcSec24(N) {
    const r = rng(20261018 + 24);
    const bm = [];                       // med3 缓冲
    const histZ = new Array(W + 1).fill(0);
    let Z = 0, mPrev1 = 0, mPrev2 = 0, zPrev1 = 0, zPrev2 = 0;
    let sZ = 0, sZ2 = 0, sZZ1 = 0, sZZ2 = 0;   // Z 矩与滞后积
    let sM = 0, sM2 = 0, sMM1 = 0, sMM2 = 0;   // med3 矩与滞后积
    let sR = 0, sR2 = 0;
    for (let i = 0; i < N; i++) {
        const x = gauss(r);
        bm.push(x); if (bm.length > 3) bm.shift();
        const m = bm.length === 3 ? med3(bm[0], bm[1], bm[2]) : x;
        Z = LAM * x + (1 - LAM) * Z;      // EWMA 作用于原始 x（式(6) 口径，不含 σeff）
        histZ.push(Z); if (histZ.length > W + 1) histZ.shift();
        sZ += Z; sZ2 += Z * Z; sZZ1 += Z * zPrev1; sZZ2 += Z * zPrev2;
        sM += m; sM2 += m * m; sMM1 += m * mPrev1; sMM2 += m * mPrev2;
        if (histZ.length === W + 1) { const roc = Z - histZ[0]; sR += roc; sR2 += roc * roc; }
        zPrev2 = zPrev1; zPrev1 = Z; mPrev2 = mPrev1; mPrev1 = m;
    }
    const vZ = sZ2 / N - (sZ / N) ** 2, vM = sM2 / N - (sM / N) ** 2;
    const rZ1 = (sZZ1 / N - (sZ / N) ** 2) / vZ, rZ2 = (sZZ2 / N - (sZ / N) ** 2) / vZ;
    const rM1 = (sMM1 / N - (sM / N) ** 2) / vM, rM2 = (sMM2 / N - (sM / N) ** 2) / vM;
    const sigmaREmp = Math.sqrt(sR2 / N - (sR / N) ** 2);
    return { vZ, vM, rZ1, rZ2, rM1, rM2, sigmaREmp };
}

// ---------- 表11 误报率/ARL₀（N = 1×10⁸ 尾部计数） ----------
function farScan(N, Ls) {
    const r = rng(20261018 + 11);
    const histZ = new Array(W + 1).fill(0);
    let Z = 0;
    const counts = Ls.map(() => 0);
    const thrs = Ls.map(L => L * SIGMA_R);
    for (let i = 0; i < N; i++) {
        const x = gauss(r);
        Z = LAM * x + (1 - LAM) * Z;
        histZ.push(Z); if (histZ.length > W + 1) histZ.shift();
        if (histZ.length < W + 1) continue;
        const roc = Z - histZ[0];
        const a = Math.abs(roc);
        for (let j = 0; j < Ls.length; j++) if (a > thrs[j]) counts[j]++;
    }
    return Ls.map((L, j) => ({
        L,
        farAnalytic: 3600 * 2 * (1 - phi(L)),      // 解析（高斯近似）
        farMC: counts[j] / N * 3600,               // 复算（蒙特卡洛）
        arlMC: N / counts[j] / 3600,               // ARL₀（h），基于复算
    }));
}
function phi(z) { // N(0,1) CDF (Abramowitz-Stegun 7.1.26)
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const p = 1 - 0.3989423 * Math.exp(-z * z / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z >= 0 ? p : 1 - p;
}

// ---------- 表14 解耦：解析 + 长跑实测 ----------
function decoupling() {
    // 解析：σr = σ·√(2λ/(2−λ)) / W_eff(min)
    const analytic = [];
    for (const dt of [0.15, 0.5, 1.5]) {
        const Wunfixed = 20 * dt / 60;            // 解耦前：固定 20 条样本
        const sUnfixed = SIG * Math.sqrt(2 * LAM / (2 - LAM)) / Wunfixed;
        analytic.push({ dt, wEffUnfixedMin: Wunfixed, sigmaRUnfixed: sUnfixed, sigmaRFixed: SIGMA_R });
    }
    // 实测：长跑噪声，Δt 采样；解耦前 = 最近 20 条样本差，解耦后 = 时间裁剪 60 s（年龄最近）
    const measured = [];
    for (const dt of [0.15, 0.5, 1.5]) {
        const r = rng(20261018 + 14 + Math.round(dt * 100));
        const N = 400000;
        let Z = 0;
        const buf = [];                       // 解耦前：固定 20 条
        const hist = [];                      // 解耦后：60 s 时间裁剪历史
        let t = 0;
        let sU = 0, sU2 = 0, sF = 0, sF2 = 0, nU = 0, nF = 0;
        for (let i = 0; i < N; i++) {
            const x = gauss(r);
            Z = LAM * x + (1 - LAM) * Z;
            t += dt;
            buf.push(Z); if (buf.length > 20) buf.shift();
            if (buf.length === 20) {
                const rocU = (Z - buf[0]) / (20 * dt / 60);
                sU += rocU; sU2 += rocU * rocU; nU++;
            }
            hist.push({ z: Z, t });
            while (t - hist[0].t > 61) hist.shift();
            let best = null, bestGap = Infinity;
            for (let k = hist.length - 2; k >= 0; k--) {
                const gap = Math.abs((t - hist[k].t) - 60);
                if (gap < bestGap) { bestGap = gap; best = hist[k]; }
                if (t - hist[k].t > 60.5) break;
            }
            if (best && t - best.t >= 59) {
                const rocF = (Z - best.z) / ((t - best.t) / 60);
                sF += rocF; sF2 += rocF * rocF; nF++;
            }
        }
        measured.push({
            dt,
            sigmaRUnfixed: Math.sqrt(sU2 / nU - (sU / nU) ** 2),
            sigmaRFixed: Math.sqrt(sF2 / nF - (sF / nF) ** 2),
        });
    }
    return { analytic, measured };
}

// ---------- 主流程 ----------
console.log('=== §2.4 蒙特卡洛（N = 3×10⁶，σ = 1.0） ===');
const s24 = mcSec24(3000000);
console.log(`  Var(Z)（原始x→EWMA） = ${s24.vZ.toFixed(4)}σ²（解析 λ/(2−λ) = ${(LAM / (2 - LAM)).toFixed(4)}）`);
console.log(`  r_Z(1) = ${s24.rZ1.toFixed(3)}，r_Z(2) = ${s24.rZ2.toFixed(3)}（解析 (1−λ)=0.8、0.64）`);
console.log(`  Var(m)（3点中值） = ${s24.vM.toFixed(4)}σ²`);
console.log(`  r_m(1) = ${s24.rM1.toFixed(3)}，r_m(2) = ${s24.rM2.toFixed(3)}`);
console.log(`  σr 经验值 = ${s24.sigmaREmp.toFixed(4)} ℃·min⁻¹（式(6) 解析 = ${SIGMA_R.toFixed(4)}）`);

console.log('\n=== 表11 判决限—误报率（1 Hz 逐样本，|roc| ≥ L·σr，N = 1×10⁸） ===');
console.log('  L      | 误报率解析(次/h) | 误报率复算(次/h) | 复算/解析 | ARL₀(复算,h)');
for (const row of farScan(100000000, [3.0, 3.5, 4.0, 4.24, 4.25, 4.5, 4.68, 4.71, 4.82, 5.0])) {
    console.log(`  ${row.L.toFixed(2).padStart(5)} | ${row.farAnalytic.toExponential(2).padStart(13)} | ${row.farMC.toExponential(2).padStart(13)} | ${(row.farMC / row.farAnalytic).toFixed(1).padStart(8)} | ${row.arlMC.toFixed(1).padStart(9)}`);
}

console.log('\n=== 表14 解耦（σr，℃·min⁻¹；解耦前 = 固定 20 条样本，解耦后 = 恒 60 s） ===');
console.log('  轮询 Δt | 解耦前等效窗口 | 解耦前σr(解析) | 解耦后σr(解析) | 解耦前σr(实测) | 解耦后σr(实测)');
const dec = decoupling();
for (let i = 0; i < dec.analytic.length; i++) {
    const a = dec.analytic[i], m = dec.measured[i];
    console.log(`  ${String(a.dt).padStart(6)} s | ${(a.wEffUnfixedMin * 60).toFixed(0).padStart(12)} s | ${a.sigmaRUnfixed.toFixed(3).padStart(13)} | ${a.sigmaRFixed.toFixed(3).padStart(13)} | ${m.sigmaRUnfixed.toFixed(3).padStart(13)} | ${m.sigmaRFixed.toFixed(3).padStart(13)}`);
}
