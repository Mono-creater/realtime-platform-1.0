/**
 * R5 复算脚本 —— 《受电弓碳滑板在线监测的双包上报协议与告警运维闭环》配套数据
 *
 * 设计原则：
 *   1. 全部数据在本脚本内重新生成，不引用任何历史结果文件；
 *   2. 被测对象为平台后端纯逻辑模块（协议编解码、告警引擎、链路监测、运维服务），
 *      经 require 直接调用，测得即代码实际行为；
 *   3. 每个实验独立随机种子，结果可复现；
 *   4. 不涉及弓头姿态通道与 PID 整定。
 *
 * 运行：node exp_R5_all.js      （工作目录 D:\realtime-platform\论文实验数据\R5）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const P = '../../../';
const PK = require(P + 'plc-packet.js');
const { AlarmEngine } = require(P + 'alarm-engine.js');
const std = require(P + 'standards.js');
const { LinkMonitor } = require(P + 'link-monitor.js');
const M = require(P + 'maintenance.js');

const OUT = __dirname + '/';
const log = [];
function say(s) { console.log(s); log.push(s); }
function dump(name, rows) {
    if (!rows || !rows.length) { say(`  [skip] ${name}`); return; }
    const keys = Object.keys(rows[0]);
    const csv = '\uFEFF' + keys.join(',') + '\n' +
        rows.map((r) => keys.map((k) => {
            const v = r[k];
            return typeof v === 'string' && /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        }).join(',')).join('\n');
    fs.writeFileSync(OUT + name, csv, 'utf8');
    say(`  -> ${name}  (${rows.length} 行)`);
}

/* 可复现伪随机：线性同余，32 bit */
function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
}
/* Box–Muller 标准正态 */
function gauss(r) {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const BASE = { pressure: 500, humidity: 50 };

/* =======================================================================
 * E1  定点编码量化误差与位宽边界
 * ==================================================================== */
say('\n=== E1 定点编码量化误差与位宽边界 ===');
{
    const scan = (name, lo, hi, step, enc, dec) => {
        const rows = [];
        let maxAbs = 0, sumAbs = 0, n = 0;
        for (let x = lo; x <= hi + 1e-9; x += step) {
            const back = dec(enc(x));
            const e = Math.abs(back - x);
            if (e > maxAbs) maxAbs = e;
            sumAbs += e; n++;
            rows.push({ x: +x.toFixed(4), raw: enc(x), back: +back.toFixed(4), abs_err: +e.toFixed(6) });
        }
        return { name, n, maxAbs, meanAbs: sumAbs / n, rows };
    };
    const S = [];
    const t = scan('temperature', -10, 80, 0.05, PK.encodeTemperature, PK.decodeTemperature);
    const p = scan('pressure', 0, 1000, 0.05, PK.encodePressure, PK.decodePressure);
    const h = scan('humidity', 0, 100, 0.05, PK.encodeHumidity, PK.decodeHumidity);
    S.push({ signal: '温度 temperature', unit: '℃', range: '-10 ~ 80', points: t.n,
             max_abs_err: +t.maxAbs.toFixed(6), mean_abs_err: +t.meanAbs.toFixed(6),
             half_lsb: 0.05, verdict: t.maxAbs <= 0.05 + 1e-9 ? '满足' : '不满足' });
    S.push({ signal: '压力 pressure', unit: 'kPa', range: '0 ~ 1000', points: p.n,
             max_abs_err: +p.maxAbs.toFixed(6), mean_abs_err: +p.meanAbs.toFixed(6),
             half_lsb: 0.05, verdict: p.maxAbs <= 0.05 + 1e-9 ? '满足' : '不满足' });
    S.push({ signal: '湿度 humidity', unit: '%RH', range: '0 ~ 100', points: h.n,
             max_abs_err: +h.maxAbs.toFixed(6), mean_abs_err: +h.meanAbs.toFixed(6),
             half_lsb: 0.05, verdict: h.maxAbs <= 0.05 + 1e-9 ? '满足' : '不满足' });
    dump('E1_quantization.csv', S);
    say(`   温度 max=${t.maxAbs.toFixed(6)} mean=${t.meanAbs.toFixed(6)} (${t.n} 点)`);
    say(`   压力 max=${p.maxAbs.toFixed(6)} mean=${p.meanAbs.toFixed(6)} (${p.n} 点)`);
    say(`   湿度 max=${h.maxAbs.toFixed(6)} mean=${h.meanAbs.toFixed(6)} (${h.n} 点)`);

    // 位宽边界
    const B = [];
    B.push({ case: '温度下限 -10 ℃', physical: '-10 ℃', scale: '×10',
             raw: PK.encodeTemperature(-10), decoded: PK.decodeTemperature(PK.encodeTemperature(-10)) + ' ℃',
             note: '补码负值还原' });
    B.push({ case: '温度上限 80 ℃', physical: '80 ℃', scale: '×10',
             raw: PK.encodeTemperature(80), decoded: PK.decodeTemperature(PK.encodeTemperature(80)) + ' ℃',
             note: '远小于 uint16 上限' });
    B.push({ case: '压力满量程 1000 kPa', physical: '1000 kPa', scale: '×10',
             raw: PK.encodePressure(1000), decoded: PK.decodePressure(PK.encodePressure(1000)) + ' kPa',
             note: '×10 编码安全' });
    B.push({ case: '压力越限 7000 kPa', physical: '7000 kPa', scale: '×10',
             raw: PK.encodePressure(7000), decoded: PK.decodePressure(PK.encodePressure(7000)) + ' kPa',
             note: '钳位，未越 65535' });
    B.push({ case: '×100 方案在 1000 kPa', physical: '1000 kPa', scale: '×100',
             raw: 100000, decoded: '溢出', note: '>65535，触发 Modbus 异常码 4' });
    B.push({ case: '×100 方案可表示上限', physical: '655.35 kPa', scale: '×100',
             raw: 65535, decoded: '655.35 kPa', note: '低于 1000 kPa 量程，不可用' });
    B.push({ case: '×10 方案可表示上限', physical: '6553.5 kPa', scale: '×10',
             raw: 65535, decoded: '6553.5 kPa', note: '覆盖全量程' });
    dump('E1_bitwidth.csv', B);
}

/* =======================================================================
 * E2  双包协议事务字节数与日流量
 * ==================================================================== */
say('\n=== E2 双包协议流量 ===');
{
    // Modbus TCP: MBAP 7 B + PDU。FC03 请求 PDU = 1(功能码)+2(起始)+2(数量)=5 B
    // FC03 响应 PDU = 1 + 1(字节数) + 2*N
    const MBAP = 7, REQ_PDU = 5;
    const respPDU = (n) => 1 + 1 + 2 * n;
    // 完整事务 = 请求帧（MBAP 7 + PDU 5）+ 响应帧（MBAP 7 + PDU 1+1+2N）
    const txMain = (MBAP + REQ_PDU) + (MBAP + respPDU(5));   // 读 2001—2005
    const txSub = (MBAP + REQ_PDU) + (MBAP + respPDU(5));    // 追加读 2011—2015
    const txWr = (MBAP + 1 + 2 + 2 + 2 * 2) + (MBAP + 1 + 1 + 2 * 2); // FC16 写 2 寄存器 + 响应
    say(`   主包事务 = (${MBAP}+${REQ_PDU}) + (${MBAP}+${respPDU(5)}) = ${txMain} B；异常周期追加子包 = ${txSub} B；合计 ${txMain + txSub} B`);
    say(`   FC16 写回事务 ≈ ${txWr} B`);

    const rows = [];
    for (const P of [0.5, 1, 2, 5, 10, 20]) {
        for (const rate of [0, 0.01, 0.05, 0.10, 0.30, 1.0]) {
            const perDay = 86400 / P;
            const b = perDay * (txMain + rate * txSub);
            rows.push({
                poll_P_s: P, anomaly_rate: +(rate * 100).toFixed(0),
                tx_bytes_per_poll: txMain + rate * txSub,
                polls_per_day: +perDay.toFixed(0),
                daily_MB: +(b / 1048576).toFixed(4),
            });
        }
    }
    // 基线：三通道 100 Hz、32 bit float 全量上传
    const baseline = 86400 * 3 * 100 * 4 / 1048576;
    rows.forEach((r) => { r.compress_x = +(baseline / r.daily_MB).toFixed(2); r.baseline_MB = +baseline.toFixed(3); });
    dump('E2_traffic.csv', rows);
    say(`   全量波形基线 = ${baseline.toFixed(3)} MB/d`);
    const r2 = rows.find((r) => r.poll_P_s === 2 && r.anomaly_rate === 0);
    say(`   P=2s/异常率0：${r2.daily_MB} MB/d，压缩 ${r2.compress_x} 倍`);
    const r2b = rows.find((r) => r.poll_P_s === 2 && r.anomaly_rate === 100);
    say(`   P=2s/异常率100%：${r2b.daily_MB} MB/d，压缩 ${r2b.compress_x} 倍`);
}

/* =======================================================================
 * E3  丢包率估计精度（含序号回绕边界）
 * ==================================================================== */
say('\n=== E3 丢包率估计精度 ===');
{
    const SEQ_MOD = 65536;
    const rows = [];
    const REP = 200, N = 1000;
    for (const truth of [0.01, 0.02, 0.05, 0.10, 0.20, 0.30, 0.40, 0.50]) {
        const est = [];
        for (let k = 0; k < REP; k++) {
            const r = rng(7000 + k * 13 + Math.round(truth * 1000));
            const lm = new LinkMonitor();
            let delivered = 0;
            for (let i = 0; i < N; i++) {
                if (r() < truth) continue;             // 丢失该帧（不送平台）
                delivered++;
                lm.onPacket({ t: i * 1000, seq: (i % 65535) + 1 });
            }
            est.push(lm.stats().lossRate * 100);
        }
        const mean = est.reduce((a, b) => a + b, 0) / est.length;
        const sd = Math.sqrt(est.reduce((a, b) => a + (b - mean) ** 2, 0) / (est.length - 1));
        const mae = est.reduce((a, b) => a + Math.abs(b - truth * 100), 0) / est.length;
        rows.push({ true_loss_pct: +(truth * 100).toFixed(2), est_mean_pct: +mean.toFixed(4),
                     bias_pp: +(mean - truth * 100).toFixed(4), sd_pp: +sd.toFixed(4),
                     mae_pp: +mae.toFixed(4), rep: REP, frames_per_trial: N });
        say(`   真值 ${(truth * 100).toFixed(0)}% → 估计 ${mean.toFixed(3)}%  偏差 ${(mean - truth * 100).toFixed(3)} pp  MAE ${mae.toFixed(3)} pp  SD ${sd.toFixed(3)} pp`);
    }
    dump('E3_lossrate.csv', rows);

    // ---- 回绕模数缺陷的定量验证与修正 ----
    // PLC 侧序号语义：seq >= 65535 ? 1 : seq+1 —— 即 65535→1，序号 0 保留不用。
    // 因此序号取值域为 {1,…,65535}，共 65535 个值，循环长度应为 65535。
    // 若按 mod 65536 计算步长，回绕点 (65535→1) 的步长被算成 2，凭空产生 1 个缺口。
    const W = [];
    {
        // (a) 现实现模数下的零丢包长程表现
        const l1 = new LinkMonitor();
        let spurious = 0, wraps = 0, prev = 0;
        const N = 65535 * 3;
        for (let i = 1; i <= N; i++) {
            const seq = (i % 65535) + 1;                 // PLC 实际回绕路径
            if (prev === 65535 && seq === 1) wraps++;
            const d = prev === 0 ? 1 : (seq - prev + 65536) % 65536;
            if (prev !== 0 && d > 1) spurious += d - 1;
            l1.onPacket({ t: i * 1000, seq });
            prev = seq;
        }
        const st1 = l1.stats();
        // (b) 修正模数：取值域长度 65535
        let spurious2 = 0;
        prev = 0;
        for (let i = 1; i <= N; i++) {
            const seq = (i % 65535) + 1;
            const d = prev === 0 ? 1 : ((seq - prev - 1 + 65535) % 65535) + 1;
            if (prev !== 0 && d > 1) spurious2 += d - 1;
            prev = seq;
        }
        W.push({ item: '仿真帧数', value: N });
        W.push({ item: '回绕次数', value: wraps });
        W.push({ item: '现实现(mod 65536) 零丢包链路虚假缺口数', value: spurious });
        W.push({ item: '修正模数(mod 65535) 虚假缺口数', value: spurious2 });
        W.push({ item: '现实现虚假丢包率 / %', value: +((spurious / (N + 1)) * 100).toFixed(6) });
        W.push({ item: '修正后虚假丢包率 / %', value: +((spurious2 / (N + 1)) * 100).toFixed(6) });
        W.push({ item: '现实现估计丢包率 / %', value: +(st1.lossRate * 100).toFixed(6) });
        W.push({ item: '单次回绕引入的虚假缺口 / 帧', value: +(spurious / wraps).toFixed(4) });
        W.push({ item: '虚假丢包率相对量级 (1/N)', value: '≈1.5×10⁻⁵' });
        say(`   回绕缺陷：${N} 帧 / ${wraps} 次回绕，现实现虚假缺口 ${spurious} 个（虚假丢包率 ${((spurious / (N + 1)) * 100).toFixed(6)}%），修正模数后 ${spurious2} 个`);
    }
    dump('E3_wrap_modulus.csv', W);

    // ---- 修正模数下的丢包估计精度（与现实现对照）----
    const cmp = [];
    const REP2 = 200, NF = 1000;
    for (const truth of [0.01, 0.05, 0.10, 0.20, 0.50]) {
        const a = [], b = [];
        for (let k = 0; k < REP2; k++) {
            const r = rng(7700 + k * 17 + Math.round(truth * 1000));
            const l1 = new LinkMonitor();                       // 现实现
            let g1 = 0, e1 = 0, prev1 = 0;
            const l2 = { gaps: 0, expected: 0 };               // 修正模数
            let g2 = 0, e2 = 0, prev2 = 0;
            for (let i = 1; i <= NF; i++) {
                const keep = r() >= truth;
                const seq = (i % 65535) + 1;
                if (keep) {
                    l1.onPacket({ t: i * 1000, seq });
                    if (prev1 !== 0) { const d = (seq - prev1 + 65536) % 65536; if (d > 1) g1 += d - 1; e1 += d; } else e1 += 1;
                    if (prev2 !== 0) { const d = ((seq - prev2 - 1 + 65535) % 65535) + 1; if (d > 1) g2 += d - 1; e2 += d; } else e2 += 1;
                    prev1 = seq; prev2 = seq;
                }
            }
            a.push(Math.min(1, g1 / Math.max(e1, 1)) * 100);
            b.push(Math.min(1, g2 / Math.max(e2, 1)) * 100);
        }
        const ma = a.reduce((x, y) => x + y, 0) / a.length;
        const mb = b.reduce((x, y) => x + y, 0) / b.length;
        cmp.push({ true_loss_pct: +(truth * 100).toFixed(2),
                   est_mod65536_pct: +ma.toFixed(4), bias_mod65536_pp: +(ma - truth * 100).toFixed(4),
                   est_mod65535_pct: +mb.toFixed(4), bias_mod65535_pp: +(mb - truth * 100).toFixed(4),
                   rep: REP2 });
        say(`   真值 ${(truth * 100).toFixed(0)}%：现实现 ${ma.toFixed(3)}%（偏差 ${(ma - truth * 100).toFixed(3)} pp） vs 修正 ${mb.toFixed(3)}%（偏差 ${(mb - truth * 100).toFixed(3)} pp）`);
    }
    dump('E3_modulus_compare.csv', cmp);

    // 边界用例
    const B = [];
    const caseOf = (name, seqs) => {
        const lm = new LinkMonitor();
        for (const s of seqs) lm.onPacket({ t: 0, seq: s });
        const st = lm.stats();
        // 同时用修正模数复算
        let g2 = 0, e2 = 0, prev = 0;
        for (const s of seqs) {
            if (prev === 0) e2 += 1;
            else { const d = ((s - prev - 1 + 65535) % 65535) + 1; if (d > 1) g2 += d - 1; e2 += d; }
            prev = s;
        }
        B.push({ case: name, seq_path: seqs.join('→'), packets: st.packets,
                 gaps_mod65536: st.gaps, loss_mod65536_pct: +(st.lossRate * 100).toFixed(4),
                 gaps_mod65535: g2, loss_mod65535_pct: +((g2 / Math.max(e2, 1)) * 100).toFixed(4) });
    };
    caseOf('零丢包（含 65535→1 回绕）', [65533, 65534, 65535, 1, 2, 3]);
    caseOf('回绕点丢 1 帧', [65534, 65535, 2, 3]);
    caseOf('回绕点丢 2 帧', [65534, 65535, 3, 4]);
    caseOf('中部丢 3 帧', [10, 11, 15, 16]);
    caseOf('重复帧不重复计缺口', [10, 11, 11, 12]);
    caseOf('旧固件全 0 帧', [0, 0, 0]);
    dump('E3_boundary.csv', B);
    B.forEach((b) => say(`   ${b.case}: 现实现 gaps=${b.gaps_mod65536}（${b.loss_mod65536_pct}%），修正 mod65535 gaps=${b.gaps_mod65535}（${b.loss_mod65535_pct}%）`));
}

/* =======================================================================
 * E4  数据质量码状态机
 * ==================================================================== */
say('\n=== E4 数据质量码状态机 ===');
{
    const lm = new LinkMonitor();
    const r = rng(9090);
    let mism = 0, N = 20000;
    const cnt = { GOOD: 0, STALE: 0, BAD: 0 };
    // 先建立"最近一帧报文"时刻基准，再在其后随机时刻查询质量码
    const lastAt = 100000;
    for (let i = 0; i < N; i++) {
        const t = lastAt + r() * 60000;                  // 断链后 0 ~ 60 s 的随机时刻
        const age = t - lastAt;
        let want;
        if (age > lm.cfg.badMs) want = 'BAD';
        else if (age > lm.cfg.staleMs) want = 'STALE';
        else want = 'GOOD';
        const got = lm.quality(t);
        cnt[got]++;
        if (got !== want) mism++;
    }
    say(`   随机时刻查询 ${N} 次，与式定义不一致 ${mism} 次`);
    say(`   分布：GOOD ${cnt.GOOD} / STALE ${cnt.STALE} / BAD ${cnt.BAD}`);
    dump('E4_quality.csv', [
        { item: '随机查询次数', value: N }, { item: '与解析定义不一致次数', value: mism },
        { item: 'GOOD 计数', value: cnt.GOOD }, { item: 'STALE 计数', value: cnt.STALE },
        { item: 'BAD 计数', value: cnt.BAD },
        { item: 'staleMs / ms', value: lm.cfg.staleMs }, { item: 'badMs / ms', value: lm.cfg.badMs },
        { item: '采样时刻区间 / ms', value: `${lastAt} ~ ${lastAt + 60000}` },
    ]);

    // 边界精确性：age 恰等于阈值时的归属
    const edge = [];
    for (const age of [2999, 3000, 3001, 9999, 10000, 10001]) {
        const l = new LinkMonitor();
        l.onPacket({ t: 0, seq: 1 });
        edge.push({ age_ms: age, quality: l.quality(age), expected: age > 10000 ? 'BAD' : (age > 3000 ? 'STALE' : 'GOOD'), match: '—' });
    }
    edge.forEach((e) => { e.match = e.quality === e.expected ? '一致' : '不一致'; });
    dump('E4_quality_edge.csv', edge);
    edge.forEach((e) => say(`   age=${String(e.age_ms).padStart(5)} ms → ${e.quality}（${e.match}）`));

    // 断链-恢复时间轨迹
    const lm2 = new LinkMonitor();
    lm2.onPacket({ t: 0, seq: 1 });
    const traj = [];
    let firstStale = null, firstBad = null;
    for (let t = 100; t <= 20000; t += 100) {
        const q = lm2.quality(t);
        if (q === 'STALE' && firstStale === null) firstStale = t;
        if (q === 'BAD' && firstBad === null) firstBad = t;
        if (t % 1000 === 0) traj.push({ t_ms: t, quality: q });
    }
    lm2.onPacket({ t: 20000, seq: 2 });
    traj.push({ t_ms: 20000, quality: lm2.quality(20000) });
    say(`   断链后 ${firstStale} ms 进入 STALE、${firstBad} ms 进入 BAD；恢复一帧后立即 GOOD`);
    dump('E4_quality_timeline.csv', traj);
}

/* =======================================================================
 * E5  指数退避重连
 * ==================================================================== */
say('\n=== E5 指数退避重连 ===');
{
    const lm = new LinkMonitor();
    const obs = [];
    for (let step = 1; step <= 8; step++) {
        lm.onError();
        const N = 4000;
        const arr = [];
        for (let k = 0; k < N; k++) arr.push(lm.nextRetryDelay());
        arr.sort((a, b) => a - b);
        const nom = Math.min(lm.cfg.maxBackoffMs, lm.cfg.baseBackoffMs * Math.pow(2, step - 1));
        obs.push({ step, nominal_ms: nom, min_ms: arr[0], p05_ms: arr[Math.floor(0.05 * N)],
                   median_ms: arr[Math.floor(0.5 * N)], p95_ms: arr[Math.floor(0.95 * N)],
                   max_ms: arr[N - 1], jitter_ok: arr[N - 1] <= Math.ceil(nom * 1.1) ? '是' : '否' });
        say(`   第 ${step} 步 名义 ${nom} ms，实测 [${arr[0]}, ${arr[N - 1]}] 中位 ${arr[Math.floor(0.5 * N)]}`);
    }
    dump('E5_backoff.csv', obs);
}

/* =======================================================================
 * E6  写入—回读校验
 * ==================================================================== */
say('\n=== E6 写入—回读校验 ===');
{
    (async () => {
        const lm = new LinkMonitor();
        // 一致
        let reg = 1000;
        const okRec = await lm.writeVerify({ write: (r, v) => { reg = v; }, read: () => reg, reg: 2021, value: 1000 });
        // 永久不一致（模拟写丢失）
        const badRec = await lm.writeVerify({ write: () => {}, read: () => 50, reg: 2021, value: 1000 });
        // 第 2 次才一致
        let n = 0;
        const rec2 = await lm.writeVerify({ write: () => { n++; reg = 1000; }, read: () => (n >= 2 ? reg : 0), reg: 2021, value: 1000 });
        dump('E6_writeverify.csv', [
            { case: '一次写入即一致', attempts: okRec.attempts, ok: okRec.ok ? '是' : '否', readback: okRec.readback },
            { case: '写丢失（永久不一致）', attempts: badRec.attempts, ok: badRec.ok ? '是' : '否', readback: badRec.readback },
            { case: '第 2 次尝试一致', attempts: rec2.attempts, ok: rec2.ok ? '是' : '否', readback: rec2.readback },
            { case: '容差 tol（寄存器单位）', attempts: lm.cfg.baseBackoffMs, ok: '0.5', readback: '压力 0.05 kPa' },
        ]);
        say(`   一次通过 attempts=${okRec.attempts}；永久不一致 attempts=${badRec.attempts} ok=${badRec.ok}；第2次通过 attempts=${rec2.attempts}`);

        /* ===============================================================
         * E7  告警引擎三组对照
         * =========================================================== */
        say('\n=== E7 告警引擎三组对照（噪声 / 尖峰 / 缓变） ===');
        const CFG = {
            A_confirm: { voteEnabled: false, confirmN: 2 },
            B_slope: { voteEnabled: true, voteSlopeMode: true, confirmN: 2, voteWindowMs: 45000 },
            C_hybrid: { voteEnabled: true, voteSlopeMode: 'hybrid', confirmN: 2,
                        voteWindowMs: 45000, voteRatio: 0.5, voteMinSamples: 2, slopeSpanMs: 20000 },
        };
        const DUR = 300000, NT = 300, SIGMA = 1.0;

        // 基线：仅阈值（无变化率）
        const thrOnly = JSON.parse(JSON.stringify(std.ALARM_DEFAULTS));
        for (const k of Object.keys(thrOnly)) delete thrOnly[k].rocPerMin;

        function runNoise(cfg, seed, sigma) {
            const e = new AlarmEngine(cfg); const r = rng(seed); let g = r() * 2 - 1;
            for (let t = 0; t <= DUR; t += 1000) {
                g = g * 0.9 + (r() * 2 - 1) * 0.1;
                e.push({ t, ...BASE, temperature: 25 + g * sigma });
            }
            return e.alarms.filter((a) => a.signal === 'temperature');
        }
        function runSpike(cfg, seed, period) {
            const e = new AlarmEngine(cfg); const r = rng(seed); let g = r() * 2 - 1;
            for (let t = 0; t <= DUR; t += 1000) {
                g = g * 0.9 + (r() * 2 - 1) * 0.1;
                e.push({ t, ...BASE, temperature: 25 + g + ((t % period === period / 2) ? 70 : 0) });
            }
            return e.alarms.filter((a) => a.signal === 'temperature');
        }
        function runRamp(cfg, seed, rateCperMin, dur) {
            const D = dur || DUR;
            const e = new AlarmEngine(cfg); const r = rng(seed);
            for (let t = 0; t <= D; t += 1000) {
                e.push({ t, ...BASE, temperature: 25 + (rateCperMin / 60) * (t / 1000) + (r() * 2 - 1) * 0.1,
                         truthOnsetMs: 0 });
            }
            return e.alarms.filter((a) => a.signal === 'temperature');
        }

        const rows = [];
        for (const name of Object.keys(CFG)) {
            const cfg = CFG[name];
            let nSum = 0;
            for (let k = 0; k < NT; k++) nSum += runNoise(cfg, 31000 + k, SIGMA).length;
            let sSum = 0, sRoc = 0, sThr = 0;
            for (let k = 0; k < NT; k++) {
                const a = runSpike(cfg, 32000 + k, 30000);
                sSum += a.length;
                sRoc += a.filter((x) => x.source === 'roc').length;
                sThr += a.filter((x) => x.source === 'threshold').length;
            }
            const lats = [];
            for (let k = 0; k < 5; k++) { const a = runRamp(cfg, 33000 + k, 3); if (a.length) lats.push(a[0].t / 1000); }
            lats.sort((x, y) => x - y);
            rows.push({
                group: name,
                noise_alarms: nSum,
                noise_rate_per_h: +(nSum / NT / (DUR / 3600000)).toFixed(3),
                spike_alarms: sSum,
                spike_from_roc: sRoc, spike_from_threshold: sThr,
                ramp_latency_median_s: lats.length ? lats[Math.floor(lats.length / 2)] : '未检出',
                trials_per_cell: NT, duration_s: DUR / 1000,
            });
            const x = rows[rows.length - 1];
            say(`   ${name.padEnd(10)} 噪声=${String(nSum).padStart(4)}(${x.noise_rate_per_h}/h)  尖峰=${String(sSum).padStart(4)}(roc=${sRoc},thr=${sThr})  缓变时延=${x.ramp_latency_median_s}s`);
        }
        const baseSpike = rows[0].spike_alarms;
        rows.forEach((r) => { r.spike_reduction_pct = baseSpike > 0 ? +((1 - r.spike_alarms / baseSpike) * 100).toFixed(1) : 0; });
        dump('E7_alarm_compare.csv', rows);

        /* =============================================================
         * E8  缓变发现时延（多速率）
         * ========================================================== */
        say('\n=== E8 缓变劣化发现时延 ===');
        function thrOnlyLat(seed, rate, dur) {
            const e = new AlarmEngine({ thresholds: thrOnly }); const r = rng(seed);
            for (let t = 0; t <= dur; t += 1000) {
                e.push({ t, ...BASE, temperature: 25 + (rate / 60) * (t / 1000) + (r() * 2 - 1) * 0.1, truthOnsetMs: 0 });
            }
            return e.alarms.length ? e.alarms[0].t / 1000 : null;
        }
        const t8 = [];
        for (const rate of [1, 2, 3, 5, 10, 20]) {
            const D = 1800000;   // 30 min 上限
            const a = thrOnlyLat(41000 + rate, rate, D);
            const b = (() => { const x = runRamp({ thresholds: thrOnly }, 41000 + rate, rate, D); return x.length ? x[0].t / 1000 : null; })();
            const c = runRamp(CFG.A_confirm, 42000 + rate, rate, D);
            const d = runRamp(CFG.C_hybrid, 43000 + rate, rate, D);
            const cL = c.length ? c[0].t / 1000 : null;
            const dL = d.length ? d[0].t / 1000 : null;
            t8.push({ rate_C_per_min: rate,
                      threshold_only_s: a === null ? '漏检' : a,
                      confirm_only_s: cL === null ? '漏检' : cL,
                      hybrid_vote_s: dL === null ? '未检出' : dL,
                      advance_vs_threshold_s: (a !== null && dL !== null) ? a - dL : '—' });
            say(`   ${String(rate).padStart(2)} ℃/min：纯阈值 ${a === null ? '漏检' : a + ' s'}；连续确认 ${cL === null ? '漏检' : cL + ' s'}；本文方法 ${dL === null ? '未检出' : dL + ' s'}`);
        }
        dump('E8_ramp_latency.csv', t8);

        /* =============================================================
         * E9  ROC 工作点标定（Tvote × ρ 网格）
         * ========================================================== */
        say('\n=== E9 ROC 工作点标定 ===');
        const g9 = [];
        for (const sig of [1.0, 2.0]) {
            for (const T of [5, 10, 15, 20, 30, 45, 60, 90]) {
                for (const rho of [0.3, 0.5, 0.7]) {
                    const cfg = Object.assign({}, CFG.C_hybrid, { voteWindowMs: T * 1000, voteRatio: rho });
                    let nSum = 0, spSum = 0;
                    const SUB = 200;
                    for (let k = 0; k < SUB; k++) nSum += runNoise(cfg, 50000 + k, sig).length;
                    for (let k = 0; k < SUB; k++) spSum += runSpike(cfg, 51000 + k, 30000).length;
                    const lat = (() => { const a = runRamp(cfg, 52000, 3, 1800000); return a.length ? a[0].t / 1000 : '未检出'; })();
                    g9.push({ sigma_W_C: sig, Tvote_s: T, rho,
                              noise_alarms: nSum, spike_alarms: spSum,
                              ramp_latency_s: lat,
                              noise_per_h: +(nSum / SUB / (DUR / 3600000)).toFixed(3) });
                }
            }
        }
        dump('E9_workpoint_grid.csv', g9);
        say('   σ_W=1.0 ℃：');
        g9.filter((r) => r.sigma_W_C === 1.0).forEach((r) =>
            say(`   Tvote=${String(r.Tvote_s).padStart(2)}s ρ=${r.rho}: 噪声 ${String(r.noise_alarms).padStart(3)}（${String(r.noise_per_h).padStart(6)}/h） 尖峰 ${String(r.spike_alarms).padStart(3)} 缓变 ${r.ramp_latency_s}s`));
        say('   σ_W=2.0 ℃：');
        g9.filter((r) => r.sigma_W_C === 2.0).forEach((r) =>
            say(`   Tvote=${String(r.Tvote_s).padStart(2)}s ρ=${r.rho}: 噪声 ${String(r.noise_alarms).padStart(3)}（${String(r.noise_per_h).padStart(6)}/h） 尖峰 ${String(r.spike_alarms).padStart(3)} 缓变 ${r.ramp_latency_s}s`));

        // 短窗跨度 S 的影响
        const g9b = [];
        for (const S of [5, 10, 15, 20, 30, 45]) {
            const cfg = Object.assign({}, CFG.C_hybrid, { slopeSpanMs: S * 1000 });
            let nSum = 0, spSum = 0;
            const SUB = 200;
            for (let k = 0; k < SUB; k++) nSum += runNoise(cfg, 53000 + k, 1.0).length;
            for (let k = 0; k < SUB; k++) spSum += runSpike(cfg, 54000 + k, 30000).length;
            const lat = (() => { const a = runRamp(cfg, 55000, 3, 1800000); return a.length ? a[0].t / 1000 : '未检出'; })();
            g9b.push({ slopeSpan_S_s: S, noise_alarms: nSum, spike_alarms: spSum, ramp_latency_s: lat,
                       noise_per_h: +(nSum / SUB / (DUR / 3600000)).toFixed(3) });
            say(`   S=${String(S).padStart(2)}s（Tvote=45s, ρ=0.5）：噪声 ${nSum} 尖峰 ${spSum} 缓变 ${lat}s`);
        }
        dump('E9_slope_span.csv', g9b);

        // 三种确认机制在同一工作点的对照（含退化对照）
        const g9c = [];
        for (const [nm, cfg] of Object.entries(CFG)) {
            let nSum = 0, spSum = 0, sRoc = 0;
            const SUB = 300;
            for (let k = 0; k < SUB; k++) nSum += runNoise(cfg, 56000 + k, 1.0).length;
            for (let k = 0; k < SUB; k++) {
                const a = runSpike(cfg, 57000 + k, 30000);
                spSum += a.length; sRoc += a.filter((x) => x.source === 'roc').length;
            }
            g9c.push({ mechanism: nm, confirmN: cfg.confirmN, vote: cfg.voteEnabled ? '启用' : '不启用',
                       slope_mode: cfg.voteSlopeMode === 'hybrid' ? '短窗滑窗+占比投票' : (cfg.voteSlopeMode === true ? '纯窗级斜率' : '—'),
                       noise_alarms: nSum, spike_alarms: spSum, spike_from_roc: sRoc,
                       noise_per_h: +(nSum / SUB / (DUR / 3600000)).toFixed(3) });
        }
        dump('E9_mechanism_compare.csv', g9c);

        /* =============================================================
         * E10 ROC 噪声适用边界
         * ========================================================== */
        say('\n=== E10 ROC 噪声适用边界 ===');
        const g10 = [];
        // 理论：σ_ROC = √2·σ_W/W  （W=60 s=1 min，差分量方差 2σ²）
        // 3 点中值滤波对高斯白噪声的方差削减比 VRED=0.4487 → σ_eff=√VRED·σ_W
        // 故 σ_ROC = √2·√VRED·σ_W/W = 1.4123·σ_W（当 W=1 min）
        // 注：相邻差分 SD 与"经滤波的 σ_eff"之间的传递关系须由实测标定，见 E10_sigma_check
        const VRED = 0.4487, RW = 2.0, WMIN = 1.0;   // W = 60 s = 1 min；warning 级 ROC 阈值 2.0 ℃/min
        const K_THEORY = Math.SQRT2 * Math.sqrt(VRED);          // 1.4123
        for (const sw of [0.15, 0.22, 0.28, 0.45, 0.70, 0.95, 1.40, 1.78, 2.20, 2.80]) {
            let hit = 0;
            const TR = 60;
            for (let k = 0; k < TR; k++) {
                const e = new AlarmEngine(CFG.C_hybrid); const r = rng(60000 + k);
                for (let t = 0; t <= DUR; t += 1000) e.push({ t, ...BASE, temperature: 25 + gauss(r) * sw });
                if (e.alarms.filter((a) => a.signal === 'temperature').length > 0) hit++;
            }
            const sigEff = Math.sqrt(VRED) * sw;
            const sigRoc = K_THEORY * sw / WMIN;         // 差分标准差（未标定）
            g10.push({ sigma_W_C: sw, sigma_eff_C: +sigEff.toFixed(4),
                       sigma_ROC_undamped: +sigRoc.toFixed(4),
                       three_sigma_undamped: +(3 * sigRoc).toFixed(4),
                       sigma_W_limit_C: +(RW * WMIN / (3 * K_THEORY)).toFixed(4),
                       usable_3sigma: 3 * sigRoc <= RW ? '是' : '否',
                       trials_with_false_alarm: hit, trials: TR });
        }
        dump('E10_noise_bound.csv', g10);
        g10.forEach((r) => say(`   σ_W=${String(r.sigma_W_C).padStart(4)} ℃ → 3σ_ROC=${String(r.three_sigma_undamped).padStart(7)} （判据 ${RW}）${r.usable_3sigma === '是' ? '可用' : '不可用'}；误报试验 ${r.trials_with_false_alarm}/${r.trials}`));
        say(`   理论噪声上限 σ_W ≤ ${g10[0].sigma_W_limit_C} ℃（未标定传递关系）`);

        // 传递关系标定：实测"原始序列差分 SD"与"3 点中值后差分 SD"
        // 结论：中值滤波对相邻差分的削减比为 0.447（即差分被强烈抑制），
        // 而 _roc() 取的是 60 s 前的样本作参照（跨窗差分），须用 60 s  lag 实测。
        {
            const meas = [];
            for (const sw of [0.5, 1.0, 1.5, 2.0]) {
                const r = rng(61000);            // 同一序列同时算两种通道，保证可比
                const src = [];
                for (let i = 0; i < 4000; i++) src.push(25 + gauss(r) * sw);
                // (i) 原始序列，lag-1 差分 → 相邻样本变化率通道
                const d1 = []; for (let i = 1; i < src.length; i++) d1.push(src[i] - src[i - 1]);
                const m1 = d1.reduce((a, b) => a + b, 0) / d1.length;
                const sd1 = Math.sqrt(d1.reduce((a, b) => a + (b - m1) ** 2, 0) / (d1.length - 1));
                // (ii) 3 点中值后，lag-1 差分
                const { median3 } = require(P + 'alarm-engine.js');
                const med = []; for (let i = 2; i < src.length; i++) med.push(median3(src[i - 2], src[i - 1], src[i]));
                const d2 = []; for (let i = 1; i < med.length; i++) d2.push(med[i] - med[i - 1]);
                const m2 = d2.reduce((a, b) => a + b, 0) / d2.length;
                const sd2 = Math.sqrt(d2.reduce((a, b) => a + (b - m2) ** 2, 0) / (d2.length - 1));
                // (iii) 3 点中值后，lag-60 差分（= _roc 实际使用的跨窗差分）
                const d3 = []; for (let i = 60; i < med.length; i++) d3.push(med[i] - med[i - 60]);
                const m3 = d3.reduce((a, b) => a + b, 0) / d3.length;
                const sd3 = Math.sqrt(d3.reduce((a, b) => a + (b - m3) ** 2, 0) / (d3.length - 1));
                meas.push({ sigma_in_C: sw,
                            sd_lag1_raw: +sd1.toFixed(4), sd_lag1_median: +sd2.toFixed(4),
                            ratio_lag1: +(sd2 / sd1).toFixed(4),
                            sd_lag60_median: +sd3.toFixed(4),
                            sigma_ROC_meas: +sd3.toFixed(4),
                            theory_undamped: +(K_THEORY * sw).toFixed(4),
                            ratio_meas_over_theory: +(sd3 / (K_THEORY * sw)).toFixed(4) });
                say(`   σ_W=${sw} ℃：lag-1 差分 SD ${sd1.toFixed(3)}→${sd2.toFixed(3)}（比 ${(sd2 / sd1).toFixed(3)}）；lag-60 差分 SD ${sd3.toFixed(3)} → σ_ROC 实测 ${sd3.toFixed(3)} ℃/min，未标定理论 ${(K_THEORY * sw).toFixed(3)}`);
            }
            dump('E10_sigma_check.csv', meas);
            say(`   ⇒ 有效传递系数 K_eff = ${meas[1].ratio_meas_over_theory.toFixed(3)}×√2·√VRED ⇒ 噪声上限 σ_W ≤ ${(RW * WMIN / (3 * K_THEORY * meas[1].ratio_meas_over_theory)).toFixed(3)} ℃`);
            fs.writeFileSync(OUT + 'E10_keff.txt',
                `K_eff_ratio=${meas[1].ratio_meas_over_theory}\nK_eff=${(K_THEORY * meas[1].ratio_meas_over_theory).toFixed(4)}\nsigma_W_limit=${(RW * WMIN / (3 * K_THEORY * meas[1].ratio_meas_over_theory)).toFixed(4)}\n`, 'utf8');
        }

        /* =============================================================
         * E11 统计窗口与轮询周期解耦
         * ========================================================== */
        say('\n=== E11 统计窗口与轮询周期解耦 ===');
        {
            const g11 = [];
            for (const dt of [1000, 500, 200, 100]) {
                // 处理前：历史缓冲按样本条数固定 → 等效窗口随 dt 收缩
                const Nfix = 64;
                const equivBefore = Nfix * dt / 1000;
                // 处理后：按时间跨度定长 60 s
                const equivAfter = 60;
                // 理论 σ_ROC（滤波后）
                const sb = Math.SQRT2 * Math.sqrt(VRED) * 1.0 / equivBefore * 60;  // 归一到 ℃/min
                const sa = Math.SQRT2 * Math.sqrt(VRED) * 1.0 / equivAfter * 60;
                g11.push({ poll_dt_ms: dt, buffer_samples_fixed: Nfix,
                           equiv_window_before_s: +equivBefore.toFixed(1),
                           equiv_window_after_s: equivAfter,
                           sigma_ROC_before: +sb.toFixed(4), sigma_ROC_after: +sa.toFixed(4),
                           sensitivity_ratio: +(sb / sa).toFixed(2) });
                say(`   Δt=${String(dt).padStart(4)} ms：等效窗口 ${equivBefore.toFixed(1)} s → 60 s；σ_ROC ${sb.toFixed(3)} → ${sa.toFixed(3)} ℃/min`);
            }
            dump('E11_window_decoupling.csv', g11);

            // 滤波一致性证据：若变化率通道取原始样本差分、而阈值通道取中值输出，
            // 则两通道的噪声基底不一致 —— 阈值通道被滤波压抑，变化率通道却被放大。
            const { median3 } = require(P + 'alarm-engine.js');
            const cmp = [];
            for (const sw of [0.5, 1.0, 2.0]) {
                const r = rng(70000);
                const src = []; for (let i = 0; i < 3003; i++) src.push(gauss(r) * sw);
                // 阈值通道所见：中值输出对 warning 阈值的余量（以 σ 为单位）
                const med = []; for (let i = 2; i < src.length; i++) med.push(median3(src[i - 2], src[i - 1], src[i]));
                const sdMed = Math.sqrt(med.reduce((a, b) => a + b * b, 0) / (med.length - 1));
                // 变化率通道若取原始样本 lag-1 差分
                const dRaw = []; for (let i = 1; i < src.length; i++) dRaw.push(src[i] - src[i - 1]);
                const mr = dRaw.reduce((a, b) => a + b, 0) / dRaw.length;
                const sdRaw = Math.sqrt(dRaw.reduce((a, b) => a + (b - mr) ** 2, 0) / (dRaw.length - 1));
                // 变化率通道若取中值输出 lag-1 差分
                const dMed = []; for (let i = 1; i < med.length; i++) dMed.push(med[i] - med[i - 1]);
                const mm = dMed.reduce((a, b) => a + b, 0) / dMed.length;
                const sdMedD = Math.sqrt(dMed.reduce((a, b) => a + (b - mm) ** 2, 0) / (dMed.length - 1));
                cmp.push({ sigma_in_C: sw,
                           sd_median_output_C: +sdMed.toFixed(4),
                           sd_rocdiff_raw_C: +sdRaw.toFixed(4),
                           sd_rocdiff_median_C: +sdMedD.toFixed(4),
                           inconsistency_ratio: +(sdRaw / sdMedD).toFixed(3),
                           theory_lag1_ratio: +Math.SQRT2.toFixed(3) });
                say(`   σ_W=${sw} ℃：中值输出 SD ${sdMed.toFixed(3)}；变化率差分 SD 原始 ${sdRaw.toFixed(3)} vs 中值 ${sdMedD.toFixed(3)} ⇒ 不一致比 ${(sdRaw / sdMedD).toFixed(2)}（理论 √2=${Math.SQRT2.toFixed(3)}）`);
            }
            dump('E11_filter_consistency.csv', cmp);
        }

        /* =============================================================
         * E12 端到端告警时延
         *   模型：t_alarm = t_window + t_poll + t_margin
         *     t_window ≤ 1.0 s  PLC 侧 10 点滑窗（100 ms 采样）均值刷新
         *     t_poll  ∈ [0, P]  平台轮询相位（随机）
         *     t_margin        阈值裕度决定的越限等待
         *   对阶跃工况，t_margin = 0（越过即触发）；对缓升工况由斜率决定。
         * ========================================================== */
        say('\n=== E12 端到端告警时延 ===');
        {
            const g12 = [];
            const PLC_DT = 100, WIN = 10, P_MARGIN = 1.0;
            for (const poll of [1000, 2000, 5000]) {
                for (const [nm, kind, rate] of [['阶跃 25→85 ℃', 'step', 0],
                                                ['缓升 1.2 ℃/s', 'ramp', 1.2],
                                                ['缓升 0.5 ℃/s', 'ramp', 0.5]]) {
                    const TRIAL = 4000;
                    const lat = [];
                    let miss = 0;
                    const STEP_T = 100000;      // 真实阶跃发生在 100 s
                    for (let k = 0; k < TRIAL; k++) {
                        // 轮询相位在 [0, poll) 上均匀取样 —— 用互质步长遍历避免共振
                        const phase = ((k * 7919) % poll);
                        const noiseR = rng(80000 + k);
                        const e = new AlarmEngine(CFG.C_hybrid);
                        const buf = [];
                        let onset = null;     // PLC 侧 10 点均值首次 > 80 ℃
                        let done = false;
                        for (let ms = 0; ms <= 300000 && !done; ms += PLC_DT) {
                            const dtSec = ms / 1000;
                            let truth;
                            if (kind === 'step') truth = dtSec >= STEP_T / 1000 ? 85 : 25;
                            else truth = 25 + Math.min(60, rate * dtSec);
                            buf.push(truth + gauss(noiseR) * 0.3);   // 传感器白噪声 σ=0.3 ℃
                            if (buf.length > WIN) buf.shift();
                            const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
                            if (onset === null && avg > 80) onset = ms;
                            if (onset !== null && ms >= onset + phase) {
                                e.push({ t: ms, ...BASE, temperature: avg });
                                const a = e.alarms.filter((x) => x.signal === 'temperature');
                                if (a.length) { lat.push(a[0].t - onset); done = true; }
                            }
                        }
                        if (!done) miss++;
                    }
                    if (!lat.length) { g12.push({ scenario: nm, poll_ms: poll, trials: TRIAL, detected: 0, missed: miss }); say(`   ${nm} / ${poll} ms：全部未检出`); continue; }
                    lat.sort((a, b) => a - b);
                    const mean = lat.reduce((a, b) => a + b, 0) / lat.length;
                    const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
                    g12.push({ scenario: nm, poll_ms: poll, trials: TRIAL, detected: lat.length, missed: miss,
                               mean_ms: Math.round(mean), p50_ms: q(0.5), p95_ms: q(0.95), max_ms: q(1),
                               mean_s: +(mean / 1000).toFixed(3), p95_s: +(q(0.95) / 1000).toFixed(3) });
                    say(`   ${nm} / 轮询 ${poll} ms：检出 ${lat.length}/${TRIAL}，mean ${Math.round(mean)} ms，p50 ${q(0.5)} ms，p95 ${q(0.95)} ms，max ${q(1)} ms`);
                }
            }
            dump('E12_e2e_latency.csv', g12);

            // 时延构成拆解（解析式验证）
            const ana = [];
            for (const poll of [1000, 2000, 5000]) {
                ana.push({ poll_ms: poll, t_window_max_s: P_MARGIN,
                           t_poll_mean_s: poll / 2000,
                           t_total_mean_pred_s: +(P_MARGIN + poll / 2000).toFixed(3),
                           t_total_max_s: +(P_MARGIN + poll / 1000).toFixed(3) });
            }
            dump('E12_latency_model.csv', ana);
        }

        /* =============================================================
         * E13 工单状态机遍历
         * ========================================================== */
        say('\n=== E13 工单状态机遍历 ===');
        {
            const ACT = ['assign', 'start', 'complete', 'verify', 'cancel'];
            // 枚举所有长度 ≤ 4 的动作序列，逐条在独立工单上执行
            const seqs = [[]];
            for (let len = 1; len <= 4; len++) {
                for (const p of seqs.filter((s) => s.length === len - 1))
                    for (const a of ACT) seqs.push(p.concat(a));
            }
            const reached = new Set(), illegal = [];
            let full = 0;                              // 走完 new→assigned→in_progress→completed→verified
            let withIllegal = 0;
            for (const sq of seqs) {
                const svc = new M.MaintenanceService();
                const o = svc.create({ deviceId: 'R5-DEV', alarmId: sq.length, level: 'warning', description: '遍历用例', at: 0 });
                reached.add(o.status);
                let bad = false;
                for (const a of sq) {
                    const r = svc._transition(o.id, a, 'tester');
                    reached.add(o.status);
                    if (!r.ok) { illegal.push(`${sq.join('→')} @${a} → ${r.error}`); bad = true; }
                }
                if (bad) withIllegal++;
                if (o.status === 'verified') full++;
            }
            say(`   枚举动作序列 ${seqs.length} 条（含空序列），含非法迁移的 ${withIllegal} 条`);
            say(`   走完主链路至 verified 的序列数：${full}`);
            say(`   可达状态：${[...reached].sort().join(', ')}`);

            // 迁移矩阵（穷举 from × action）
            const mat = [];
            for (const from of ['new', 'assigned', 'in_progress', 'completed', 'verified', 'cancelled']) {
                for (const a of ACT) {
                    const svc = new M.MaintenanceService();
                    const o = svc.create({ deviceId: 'D', level: 'warning', description: 'M', at: 0 });
                    const path = { new: [], assigned: ['assign'], in_progress: ['assign', 'start'],
                                   completed: ['assign', 'start', 'complete'],
                                   verified: ['assign', 'start', 'complete', 'verify'],
                                   cancelled: ['cancel'] }[from] || [];
                    for (const p of path) svc._transition(o.id, p, 'tester');
                    const before = o.status;
                    const r = svc._transition(o.id, a, 'tester');
                    mat.push({ from, action: a, result: r.ok ? '允许' : '拒绝',
                               to: r.ok ? o.status : '—', error: r.ok ? '' : r.error });
                }
            }
            dump('E13_transition_matrix.csv', mat);
            dump('E13_state_machine.csv', [
                { item: '枚举动作序列数（长度≤4）', value: seqs.length },
                { item: '含非法迁移的序列数', value: withIllegal },
                { item: '被拒绝的非法迁移条目数', value: illegal.length },
                { item: '走完主链路至 verified 的序列数', value: full },
                { item: '可达状态集合', value: [...reached].sort().join(' / ') },
                { item: '允许的迁移数', value: mat.filter((m) => m.result === '允许').length },
                { item: '拒绝的迁移数', value: mat.filter((m) => m.result === '拒绝').length },
            ]);
            mat.filter((m) => m.result === '允许').forEach((m) => say(`   允许：${m.from} --${m.action}--> ${m.to}`));

            // 审计轨迹完整性
            const svc3 = new M.MaintenanceService();
            const o3 = svc3.create({ deviceId: 'D', level: 'critical', description: '审计用例', at: 1000 });
            svc3.assign(o3.id, '张工', 2000); svc3.start(o3.id, '张工', 3000);
            svc3.complete(o3.id, '张工', 4000, '已更换滑板'); svc3.verify(o3.id, '李工', 5000, '复核合格');
            dump('E13_audit_trail.csv', o3.audit.map((a, i) => ({ seq: i + 1, action: a.action, worker: a.worker, at: a.at, note: a.note })));
            say(`   审计轨迹 ${o3.audit.length} 条：${o3.audit.map((a) => a.action).join('→')}`);

            // 告警→工单自动生成与等级映射
            const svc4 = new M.MaintenanceService();
            const { AlarmEngine: AE } = require(P + 'alarm-engine.js');
            const ae = new AE({ voteEnabled: false, confirmN: 2 });
            for (let t = 0; t <= 3000; t += 1000) ae.push({ t, ...BASE, temperature: t >= 1000 ? 95 : 25 });
            const auto = ae.alarms.filter((a) => a.signal === 'temperature')
                .map((a) => { const o = svc4.createFromAlarm(a, 'DEV1', a.t); return { alarm_level: a.level, alarm_msg: a.message, order_id: o.id, order_level: o.level, order_status: o.status }; });
            dump('E13_alarm_to_order.csv', auto);
            auto.forEach((a) => say(`   告警[${a.alarm_level}] → 工单 ${a.order_id}（${a.order_level}，${a.order_status}）`));
        }

        /* =============================================================
         * E14 健康指数响应面
         * ========================================================== */
        say('\n=== E14 健康指数响应面 ===');
        {
            const svc = new M.MaintenanceService();
            const rows = [];
            const cases = [
                { forceMean: 100, forceStd: 2, tempMax: 60, alarmCount24h: 0 },
                { forceMean: 102, forceStd: 5, tempMax: 70, alarmCount24h: 2 },
                { forceMean: 110, forceStd: 10, tempMax: 78, alarmCount24h: 5 },
                { forceMean: 115, forceStd: 15, tempMax: 82, alarmCount24h: 8 },
                { forceMean: 120, forceStd: 20, tempMax: 85, alarmCount24h: 10 },
                { forceMean: 130, forceStd: 20, tempMax: 88, alarmCount24h: 12 },
                { forceMean: 140, forceStd: 25, tempMax: 95, alarmCount24h: 20 },
            ];
            for (const c of cases) {
                const h = svc.healthIndex(Object.assign({ forceTarget: 100, tempLimit: 80 }, c));
                rows.push({ force_dev_N: +(c.forceMean - 100).toFixed(1), force_sd_N: c.forceStd,
                            temp_max_C: c.tempMax, alarm_24h: c.alarmCount24h,
                            p_force: h.penalties.force, p_wave: h.penalties.wave,
                            p_temp: h.penalties.temp, p_alarm: h.penalties.alarm,
                            score: h.score, grade: h.grade });
                say(`   ΔF=${String(c.forceMean - 100).padStart(5)} N σ=${String(c.forceStd).padStart(2)} Tmax=${c.tempMax}℃ N24h=${String(c.alarmCount24h).padStart(2)} → score ${h.score}（${h.grade}）`);
            }
            dump('E14_health_index.csv', rows);
            dump('E14_health_grade.csv', [
                { score_min: 85, score_max: 100, grade: '正常', action: '按周期巡检' },
                { score_min: 70, score_max: 84, grade: '关注', action: '加密监测，纳入下次天窗复检' },
                { score_min: 55, score_max: 69, grade: '计划检修', action: '安排计划检修工单，检查气路与接触压力' },
                { score_min: 0, score_max: 54, grade: '立即检修', action: '触发紧急工单，停运检查' },
            ]);
        }

        /* =============================================================
         * E15 KPI 复算
         * ========================================================== */
        say('\n=== E15 KPI 复算 ===');
        {
            const rows = [
                { kpi: '可用率 A', formula: '1 − t_down/t_total', input: 't_total=720 h, t_down=8 h',
                  value: +std.availability(8, 720).toFixed(4), unit: '—' },
                { kpi: '数据完整率 C', formula: 'N_good/N_exp', input: 'N_good=998, N_exp=1000',
                  value: +std.dataCompleteness(998, 1000).toFixed(4), unit: '—' },
                { kpi: '丢包率 L', formula: 'N_gap/N_exp', input: 'N_gap=3, N_exp=43200',
                  value: +std.packetLossRate(3, 43200).toFixed(6), unit: '—' },
            ];
            // MTTR：60 张工单，完成时刻按对数正态散布
            const r = rng(80000);
            const orders = [];
            let tt = 0;
            for (let i = 0; i < 60; i++) {
                const dur = Math.round(Math.exp(3.2 + gauss(r) * 0.6));   // 分钟
                orders.push({ createdAt: tt, completedAt: tt + dur * 60000 });
                tt += dur * 60000 + 3600000;
            }
            rows.push({ kpi: '平均修复时间 MTTR', formula: 'Σ(t_c − t_r)/n', input: `n=${orders.length} 张工单`,
                        value: std.mttr(orders), unit: 'min' });
            dump('E15_kpi.csv', rows);
            rows.forEach((x) => say(`   ${x.kpi}：${x.value} ${x.unit}（${x.input}）`));

            // 告警时延分位数
            const lat = [];
            for (let i = 0; i < 500; i++) lat.push(Math.round(Math.abs(gauss(r)) * 1800 + 300));
            dump('E15_latency_quantiles.csv', [
                { item: '样本数 n', value: std.latencyStats(lat).n },
                { item: '均值 mean / ms', value: std.latencyStats(lat).mean },
                { item: 'p50 / ms', value: std.latencyStats(lat).p50 },
                { item: 'p95 / ms', value: std.latencyStats(lat).p95 },
                { item: 'max / ms', value: std.latencyStats(lat).max },
            ]);
        }

        /* =============================================================
         * E16 告警阈值自洽性（接触力软测量）
         * ========================================================== */
        say('\n=== E16 阈值与软测量自洽性 ===');
        {
            const rows = [];
            for (const A of [0.0005, 0.0008, 0.001, 0.0012, 0.0015, 0.002, 0.003, 0.005, 0.01]) {
                const pNeed = 100 / (1000 * A);          // F=100 N 所需压力 kPa
                rows.push({ A_eff_m2: A, press_needed_kPa: +pNeed.toFixed(2),
                            low_limit_kPa: 100, margin_kPa: +(pNeed - 100).toFixed(2),
                            verdict: pNeed < 100 ? '必然触发低压报警' : (pNeed < 130 ? '临界（余量<30%）' : '安全') });
            }
            dump('E16_threshold_coupling.csv', rows);
            rows.forEach((r) => say(`   A_eff=${r.A_eff_m2} m² → 需 ${r.press_needed_kPa} kPa，${r.verdict}`));

            // 标准判据复算
            const S = [];
            for (const v of [0, 40, 80, 120, 160, 200, 250, 300]) {
                const ac = std.targetMeanContactForce(v, { system: 'AC' });
                const dc = std.targetMeanContactForce(v, { system: 'DC' });
                const lim = std.dynamicLimits(ac.value);
                S.push({ speed_kmh: v, Fm_AC_N: +ac.value.toFixed(3), Fm_DC_N: +dc.value.toFixed(3),
                         raw_AC_N: +ac.raw.toFixed(3),
                         sigma_max_N: +lim.sigmaMax.toFixed(3), Fmin_N: +lim.fMin.toFixed(3), Fmax_N: +lim.fMax.toFixed(3) });
                say(`   v=${String(v).padStart(3)} km/h：Fm(AC)=${ac.value.toFixed(2)} N，Fm(DC)=${dc.value.toFixed(2)} N，σmax=${lim.sigmaMax.toFixed(2)} N，Fmin=${lim.fMin.toFixed(2)} N，Fmax=${lim.fMax.toFixed(2)} N`);
            }
            dump('E16_standard_limits.csv', S);
        }

        fs.writeFileSync(OUT + 'R5_run_log.txt', log.join('\n'), 'utf8');
        say('\n全部实验完成，日志：R5_run_log.txt');
    })();
}
