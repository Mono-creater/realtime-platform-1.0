/**
 * sim-source.js —— 模拟数据源（无 PLC 时的演示信号）
 *
 * 设计目标（替换原"每 2 s 独立取随机数 + 30% 概率直接越限"）：
 *   1) 稳态段：均值回复随机游走，数值连续、不越限、不刷屏；
 *   2) 工况段：稀发（默认约 20 min 一次）注入【线性缓变】，斜率落在论文表10 的
 *      2~10 ℃/min 量级，使 EWMA 变化率通道先于阈值通道告警，可直观演示论文 §2.4；
 *   3) 序号：与 PLC 一致，1..65535，65535→1 回绕（供链路连续性判据演示）。
 *
 * 相态：rise（升到目标）→ hold（保持）→ recover（按同斜率回落至基线）
 *
 * 纯逻辑、无第三方依赖，可单测（见 tools/verify_sim.js）。
 */

'use strict';

const BASE = { temperature: 25, pressure: 250, humidity: 45 };
const TARGET = { temperature: 96, pressure: 1150, humidity: 92 };

/**
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=2000]   采样周期（决定斜率换算）
 * @param {number} [opts.riseTicks=240]     上升段长度（拍）
 * @param {number} [opts.holdTicks=20]      保持段长度（拍）
 * @param {number} [opts.recoverTicks=120]  回落段长度（拍）
 * @param {number} [opts.episodeProb=0.0008] 每拍触发工况的概率
 * @param {number} [opts.noise=1]           噪声倍率（1 = 温度 ±0.25 ℃/拍）
 */
function createSimSource(opts = {}) {
    const intervalMs = opts.intervalMs || 2000;
    const riseTicks = opts.riseTicks || 240;
    const holdTicks = opts.holdTicks !== undefined ? opts.holdTicks : 20;
    const recoverTicks = opts.recoverTicks || 120;
    const episodeProb = opts.episodeProb !== undefined ? opts.episodeProb : 0.0008;
    const noise = opts.noise !== undefined ? opts.noise : 1;

    const state = {
        temperature: BASE.temperature,
        pressure: BASE.pressure,
        humidity: BASE.humidity,
        episode: null,   // { sig, phase, ticks, step }
        seq: 1,
        ticks: 0,
    };

    /** 手工注入一次工况（演示/测试用）；返回该工况的斜率（单位/分钟） */
    function inject(sig) {
        const s = ['temperature', 'pressure', 'humidity'].includes(sig) ? sig : 'temperature';
        const step = (TARGET[s] - BASE[s]) / riseTicks;
        state.episode = { sig: s, phase: 'rise', ticks: 0, step };
        return step * (60000 / intervalMs);
    }

    function next() {
        const st = state;
        st.ticks += 1;

        // 稳态：均值回复 + 白噪声
        // 注意：工况通道（正在缓变的信号）不能施加均值回复，否则回复力会压过缓变斜率，
        // 温度永远爬不到阈值（实测注入 8.9 ℃/min 时被压回 28 ℃ 附近）。
        const activeSig = st.episode ? st.episode.sig : null;
        if (activeSig !== 'temperature') {
            st.temperature += (BASE.temperature - st.temperature) * 0.08 + (Math.random() * 2 - 1) * 0.25 * noise;
        } else {
            st.temperature += (Math.random() * 2 - 1) * 0.05 * noise;   // 工况通道仅保留小噪声
        }
        if (activeSig !== 'pressure') {
            st.pressure += (BASE.pressure - st.pressure) * 0.08 + (Math.random() * 2 - 1) * 2.0 * noise;
        } else {
            st.pressure += (Math.random() * 2 - 1) * 0.4 * noise;
        }
        if (activeSig !== 'humidity') {
            st.humidity += (BASE.humidity - st.humidity) * 0.08 + (Math.random() * 2 - 1) * 0.4 * noise;
        } else {
            st.humidity += (Math.random() * 2 - 1) * 0.1 * noise;
        }

        if (!st.episode && Math.random() < episodeProb) {
            const sig = ['temperature', 'pressure', 'humidity'][Math.floor(Math.random() * 3)];
            inject(sig);
        }

        if (st.episode) {
            const e = st.episode;
            const dir = e.phase === 'recover' ? -1 : 1;
            const nextVal = st[e.sig] + dir * e.step;
            st[e.sig] = e.phase === 'recover'
                ? Math.max(BASE[e.sig], nextVal)
                : Math.min(TARGET[e.sig], nextVal);
            e.ticks += 1;
            if (e.phase === 'rise' && e.ticks >= riseTicks) { e.phase = 'hold'; e.ticks = 0; }
            else if (e.phase === 'hold' && e.ticks >= holdTicks) { e.phase = 'recover'; e.ticks = 0; }
            else if (e.phase === 'recover' && (e.ticks >= recoverTicks || st[e.sig] <= BASE[e.sig] + 1e-9)) {
                st[e.sig] = BASE[e.sig];
                st.episode = null;
            }
        }

        st.seq = st.seq >= 65535 ? 1 : st.seq + 1;
        return {
            avg: {
                temperature: Math.round(st.temperature * 10) / 10,
                pressure: Math.round(st.pressure * 100) / 100,
                humidity: Math.round(st.humidity * 10) / 10,
            },
            seq: st.seq,
            episode: st.episode ? { sig: st.episode.sig, phase: st.episode.phase } : null,
        };
    }

    return { next, inject, state, BASE, TARGET, config: { intervalMs, riseTicks, holdTicks, recoverTicks, episodeProb, noise } };
}

module.exports = { createSimSource, BASE, TARGET };
