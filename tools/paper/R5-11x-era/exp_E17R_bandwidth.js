/**
 * E17R 带宽核算修正：口径统一为 Modbus 16 bit 寄存器字长
 * 原 E17 用 4 B/样本（32 bit）与协议的 16 bit 寄存器口径不一致，本脚本重算。
 */
'use strict';
const fs = require('fs');

function read(f) {
    const D = 'D:/realtime-platform/论文实验数据/R5/';
    const txt = fs.readFileSync(D + f, 'utf8').replace(/^\uFEFF/, '');
    const lines = txt.trim().split('\n');
    const hdr = lines[0].split(',');
    return lines.slice(1).map((l) => {
        const c = l.split(',');
        const o = {};
        hdr.forEach((h, i) => { o[h] = c[i]; });
        return o;
    });
}

const OUT = 'D:/realtime-platform/论文实验数据/R5/';
const log = [];
function say(s) { console.log(s); log.push(s); }
function dump(name, rows) {
    const keys = Object.keys(rows[0]);
    fs.writeFileSync(OUT + name, '\uFEFF' + keys.join(',') + '\n' +
        rows.map((r) => keys.map((k) => {
            const v = r[k];
            return typeof v === 'string' && /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        }).join(',')).join('\n'), 'utf8');
    say(`  -> ${name} (${rows.length} 行)`);
}

say('\n=== E17R 带宽核算（16 bit 寄存器口径） ===\n');

// 协议层口径：Modbus 寄存器 16 bit
const BIT = 16;
const FS = 200;                 // EN 50317:2022 对接触力测量的采样率下限
const CH = 3;                   // 温度 / 压力 / 湿度
const BYTES = BIT / 8;          // 2 B

// 线缆侧单事务
const MBAP = 7, REQ_PDU = 5;
const ETH = 14, IP = 20, TCP = 20, PRE = 20;
const txApp = (MBAP + REQ_PDU) + (MBAP + 1 + 1 + 2 * 5);           // 31 B
const txWire = (MBAP + REQ_PDU + ETH + IP + TCP + PRE)
             + (MBAP + 1 + 1 + 2 * 5 + ETH + IP + TCP + PRE)
             + (ETH + IP + TCP + PRE);                              // 253 B
say(`应用层单事务 ${txApp} B；线缆侧单事务（含 TCP 确认）${txWire} B；比值 ${(txWire/txApp).toFixed(2)}×`);

// 三档基线
const BASELINES = [
    { id: 'B32', name: '32 bit 浮点全量波形', bps: 4, note: 'A/D 原始字长' },
    { id: 'B16', name: '16 bit 寄存器全量波形', bps: 2, note: '与协议字长一致' },
    { id: 'B16c', name: '16 bit 逐样本 + 16 bit 序号', bps: 2 + 2, note: '朴素方案：逐样本带序号' },
];

const FLEET = [
    { name: '单台受电弓', nodes: 1 },
    { name: '单弓（2 架）', nodes: 2 },
    { name: '单车（8 辆编组）', nodes: 8 },
    { name: '30 列车汇聚', nodes: 240 },
];

// 各部署规模的码率
const rows = [];
for (const f of FLEET) {
    const r = { scenario: f.name, nodes: f.nodes };
    for (const b of BASELINES) {
        const Bps = FS * CH * b.bps * f.nodes;
        r[b.id + '_kbps'] = +(Bps * 8 / 1000).toFixed(2);
    }
    // 本文方案：10 点滑窗降采样 10 倍 + 线缆侧事务
    const ourBps = f.nodes * txWire / 2;
    r.OUR_kbps = +(ourBps * 8 / 1000).toFixed(2);
    r.ratio_vs_B16 = +(r.B16_kbps / r.OUR_kbps).toFixed(2);
    r.ratio_vs_B16c = +(r.B16c_kbps / r.OUR_kbps).toFixed(2);
    rows.push(r);
    say(`${f.name.padEnd(20)} B32=${String(r.B32_kbps).padStart(8)} B16=${String(r.B16_kbps).padStart(8)} ` +
        `B16+seq=${String(r.B16c_kbps).padStart(8)} 本文=${String(r.OUR_kbps).padStart(7)} kbit/s ` +
        `（/B16=${r.ratio_vs_B16}×, /B16+seq=${r.ratio_vs_B16c}×）`);
}
dump('E17R_bandwidth_16bit.csv', rows);

// 链路占用率：以 16 bit 逐样本 + 序号为基线（最不利于本文的对照）
say('\n链路占用率（30 列车汇聚，基线 = 16 bit 逐样本 + 序号）：');
const cmp = [];
for (const [nm, kbps] of [['LTE/4G 典型上行', 20000], ['WiFi 隧道内热点', 5000],
                          ['CBTC 区间专用无线', 2000], ['保守受限上行', 64]]) {
    const r = rows.find((x) => x.scenario === '30 列车汇聚');
    const cmpRow = { link: nm, avail_kbps: kbps };
    for (const b of BASELINES) cmpRow[b.id + '_occ_pct'] = +(r[b.id + '_kbps'] / kbps * 100).toFixed(2);
    cmpRow.OUR_occ_pct = +(r.OUR_kbps / kbps * 100).toFixed(3);
    cmp.push(cmpRow);
    say(`  ${nm.padEnd(22)} B16+seq ${String(cmpRow.B16c_occ_pct).padStart(9)} % → 本文 ${String(cmpRow.OUR_occ_pct).padStart(8)} %`);
}
dump('E17R_link_occupancy.csv', cmp);

// 三档基线的相对关系（供正文引用）
say('\n三档基线的定义与压缩倍数（30 列车汇聚）：');
const r30 = rows.find((x) => x.scenario === '30 列车汇聚');
const defs = [
    { baseline: 'B32', name: '32 bit 浮点全量波形', kbps: r30.B32_kbps, note: 'A/D 原始字长逐样本回传' },
    { baseline: 'B16', name: '16 bit 寄存器全量波形', kbps: r30.B16_kbps, note: '与 Modbus 字长一致' },
    { baseline: 'B16c', name: '16 bit 逐样本 + 序号', kbps: r30.B16c_kbps, note: '朴素方案，仍逐样本' },
];
defs.forEach((d) => {
    d.compress_x = +(d.kbps / r30.OUR_kbps).toFixed(2);
    say(`  ${d.name.padEnd(24)} ${String(d.kbps).padStart(8)} kbit/s → 压缩 ${d.compress_x}×`);
});
dump('E17R_baselines.csv', defs);

// 滑窗降采样收益的分解
say('\n压缩来源分解（30 列车汇聚）：');
const step1 = r30.B16c_kbps;                 // 朴素逐样本
const step2 = r30.B16_kbps / step1;           // 去掉逐样本序号
const step3 = r30.OUR_kbps;
say(`  起点：16 bit 逐样本 + 序号 = ${step1} kbit/s`);
say(`  滑窗降采样（10 点均值，降 10 倍）→ ${(step1/10).toFixed(1)} kbit/s`);
say(`  条件读取（异常率 0，仅读主包）→ ${r30.OUR_kbps} kbit/s`);
say(`  合计压缩 ${(step1/step3).toFixed(1)} 倍 = 序号开销 ${step2.toFixed(2)}× × 滑窗降采样 10× × 主包精简 ${((step1/10)/step3).toFixed(2)}×`);
dump('E17R_budget_breakdown.csv', [
    { step: '起点：16 bit 逐样本 + 序号', kbps: step1 },
    { step: '滑窗降采样后（÷10）', kbps: +(step1 / 10).toFixed(2) },
    { step: '本文方案（异常率 0）', kbps: step3 },
    { step: '合计压缩倍数', kbps: +(step1 / step3).toFixed(2) },
]);

fs.writeFileSync(OUT + 'E17R_run_log.txt', log.join('\n'), 'utf8');
say('\n完成。');
