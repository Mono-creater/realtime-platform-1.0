/**
 * control-engine-v2.js —— 双环 PID 控制升级（在 v1 基础上按行业做法增强）
 *
 * 相对 v1 的改进：
 *  1) 不完全微分：微分项经一阶低通（滤波系数 N），抑制编码器/压力噪声放大；
 *  2) 积分分离：|e| 超过阈值时暂停积分，避免大偏差下的积分饱和与超调；
 *  3) 设定值斜坡限速：目标值按最大变化率逼近，减小对执行机构的冲击；
 *  4) 增益调度：按运行速度用 standards.targetMeanContactForce() 计算接触力目标，
 *     并允许按速度分档切换 PID 参数（对应“分速档目标曲线”的工程做法）；
 *  5) 整定方法补全：除 Ziegler-Nichols 外，增加 IMC（λ 整定）——
 *     对纯滞后占比大的通道（姿态环 T≈0.5 s、L≈0.6 s，Z-N 不适用），
 *     IMC-PI 可给出可用参数：Kc = T / (K·(λ+L))，Ti = T，Td = 0（λ 可选）。
 *
 * 依据：Åström & Hägglund《PID Controllers》(1995) 抗饱和与微分先行章节；
 *       Ziegler & Nichols (1942) 开环阶跃整定；Rivera 等 IMC 整定（λ 形参）。
 * 本模块无第三方依赖，可直接被 server.js / 模拟器 / 测试脚本复用。
 */

'use strict';

const { targetMeanContactForce } = require('./standards');

const DEFAULTS = {
    dt: 0.5,                 // s，控制周期
    tauForce: 2.0,           // s，接触力通道一阶惯性
    tauHeight: 0.5,          // s，姿态通道一阶惯性
    deadTime: 0.6,           // s，纯滞后
    aEff: 0.001,             // m²
    fOffset: 0,
    fTarget: 100,            // N，默认目标（无速度信息时）
    hTarget: 2400,           // mm
    forceMin: 50, forceMax: 1000,      // kPa
    heightMin: 1000, heightMax: 2600,  // mm
    derivFilterN: 8,         // 不完全微分滤波强度（越大越平滑）
    integralSeparation: 0.35,// 积分分离阈值（相对量程）
    rampRate: 0,             // 设定值最大变化率（单位/s，0 表示不限速）
    speedBins: [             // 增益调度：速度分档（km/h）
        { vMax: 80, scale: 1.0 },
        { vMax: 160, scale: 0.85 },
        { vMax: 400, scale: 0.7 },
    ],
};

function znGains(K, T, L) {
    const kp = (1.2 * T) / (K * L), ti = 2 * L, td = 0.5 * L;
    return { kp, ti, td, ki: kp / ti, kd: kp * td, method: 'ZN' };
}

/** IMC-PI（FOPDT）：Kc = T/(K(λ+L))，Ti = T，Td = 0 */
function imcGains(K, T, L, lambda) {
    const lam = lambda !== undefined ? lambda : Math.max(0.8 * L, 0.2 * T);
    const kp = T / (K * (lam + L));
    const ti = T;
    return { kp, ti, td: 0, ki: kp / ti, kd: 0, lambda: lam, method: 'IMC' };
}

/**
 * 安全整定策略（本模块新增，解决“Z-N 在纯滞后主导通道上过于激进”的工程问题）
 *  - T > L：以 Z-N 结果为初值，按纯滞后占比折减增益，折减系数 r = 1/(1+L/T)（限幅 0.4~1）；
 *  - T ≤ L：Z-N 开环阶跃整定在原理上不适用（拟合无法给出有效 T），改用 IMC-PI（λ=T）；
 * 说明：折减系数为工程经验做法（纯滞后越大、增益越保守），λ 取一阶时间常数为 IMC 的稳健取法。
 */
function tuneSafe(K, T, L, opts = {}) {
    if (!(K > 0) || !(T > 0) || !(L > 0)) return { ok: false, error: '参数非法（K、T、L 必须为正）' };
    if (T <= L) {
        const g = imcGains(K, T, L, opts.lambda !== undefined ? opts.lambda : T);
        return Object.assign({ ok: true }, g, {
            reason: `T=${T}s ≤ L=${L}s：Z-N 开环整定不适用，改用 IMC-PI（λ=T）`,
        });
    }
    const zn = znGains(K, T, L);
    const reduce = opts.reduce !== undefined ? opts.reduce : Math.max(0.4, Math.min(1, 1 / (1 + L / T)));
    return {
        ok: true, method: 'ZN-折减', reason: `按纯滞后占比折减增益（1/(1+L/T)=${reduce.toFixed(3)}）`,
        reduce, kp: zn.kp * reduce, ti: zn.ti, td: zn.td, ki: zn.ki * reduce, kd: zn.kd * reduce, zn,
    };
}

/** 一阶惯性 + 纯滞后对象（与项目模拟器一致） */
function plantStep(y, u, dt, tau) { return y + ((u - y) * dt) / tau; }

/**
 * 闭环阶跃仿真（支持 v1/v2 控制律对比）
 * @param {object} c 配置：K,T,L,dt,target,y0,gains{kp,ki,kd},derivFilterN,integralSeparation,rampRate,uMin,uMax
 * @returns {{curve:Array, metrics:object}}
 */
function simulateClosedLoop(c) {
    const cfg = Object.assign({}, DEFAULTS, c);
    const gains = Object.assign({ kp: 1, ki: 0, kd: 0 }, c.gains || {});
    const dt = cfg.dt, tau = c.tau !== undefined ? c.tau : cfg.tauForce;
    const K = c.gain !== undefined ? c.gain : 1;      // 对象增益（N/kPa 或 mm/kPa）
    const N = cfg.derivFilterN || 0;                 // 0 = 完全微分（v1 行为）
    const ramp = cfg.rampRate || 0;

    let y = cfg.y0;                 // 被控量
    let u = c.u0 !== undefined ? c.u0 : cfg.target;   // 控制器输出（执行机构量）
    let integral = 0, dFilt = 0, lastMeas = y, sp = y, dead = [];
    const curve = [];
    const ticks = c.ticks || 400;
    // 积分分离阈值：按执行机构输出跨度折算到被控量单位（与现场整定的相对量程口径一致）
    const uMin = c.uMin !== undefined ? c.uMin : cfg.forceMin;
    const uMax = c.uMax !== undefined ? c.uMax : cfg.forceMax;
    const sepAbs = cfg.integralSeparation >= 1e8 ? Infinity
        : cfg.integralSeparation * Math.abs((uMax - uMin) * K);

    // 无扰切换：自动投入时以当前输出预载积分，使首个周期的控制器输出等于当前执行机构值
    // （与项目 setAuto() 的做法一致，避免投入瞬间输出跳变）
    if (gains.ki > 0 && !c.noBumpless) integral = (u - gains.kp * 0) / gains.ki;

    for (let i = 0; i < ticks; i++) {
        // 纯滞后：当前作用的输出是 L 秒前的值
        dead.push(u);
        const dSteps = Math.max(0, Math.round(cfg.L / dt));
        const uEff = dead.length > dSteps ? dead[dead.length - 1 - dSteps] : (c.u0 !== undefined ? c.u0 : cfg.target);

        // 对象推进：一阶惯性，稳态满足 y = K·u
        y = plantStep(y, K * uEff, dt, tau);

        // 设定值斜坡
        if (ramp > 0) {
            const step = ramp * dt;
            sp += Math.max(-step, Math.min(step, cfg.target - sp));
        } else {
            sp = cfg.target;
        }

        const e = sp - y;
        const dMeas = (y - lastMeas) / dt;
        // 不完全微分：dFilt = (N·dMeas + dFilt)/(N+1)
        dFilt = N > 0 ? (N * dMeas + dFilt) / (N + 1) : dMeas;

        const p = gains.kp * e;
        const iTerm = gains.ki * integral;
        const dTerm = -(gains.kd * dFilt);
        let out = p + iTerm + dTerm;
        let sat = false;
        if (out > uMax) { out = uMax; sat = true; }
        if (out < uMin) { out = uMin; sat = true; }

        // 积分：条件抗饱和 + 积分分离
        const freeze = (Math.abs(e) > sepAbs) || (sat && ((out >= uMax && e > 0) || (out <= uMin && e < 0)));
        if (!freeze) integral += e * dt;

        lastMeas = y; u = out;
        curve.push({ t: (i + 1) * dt, y, u, sp, e });
    }
    return { curve, metrics: stepMetrics(curve, cfg.target, cfg.y0) };
}

/** 阶跃响应指标：上升时间、超调、调节时间、稳态误差、输出峰值 */
function stepMetrics(curve, target, y0) {
    const ys = curve.map((p) => p.y), ts = curve.map((p) => p.t);
    const dy = target - y0;
    if (Math.abs(dy) < 1e-9) return {};
    const cross = (f) => {
        const lvl = y0 + f * dy;
        for (const p of curve) if ((dy > 0 && p.y >= lvl) || (dy < 0 && p.y <= lvl)) return p.t;
        return null;
    };
    const t10 = cross(0.1), t90 = cross(0.9);
    const overshoot = dy > 0 ? Math.max(0, (Math.max(...ys) - target) / Math.abs(dy) * 100)
                             : Math.max(0, (target - Math.min(...ys)) / Math.abs(dy) * 100);
    const band = 0.02 * Math.abs(dy);
    let settle = 0;
    for (let i = curve.length - 1; i >= 0; i--) { if (Math.abs(ys[i] - target) > band) { settle = ts[i]; break; } }
    const tail = ys.slice(-10), sse = target - tail.reduce((a, b) => a + b, 0) / tail.length;
    const us = curve.map((p) => p.u);
    return {
        riseS: (t10 !== null && t90 !== null) ? +(t90 - t10).toFixed(2) : null,
        overshootPct: +overshoot.toFixed(2),
        settleS: +settle.toFixed(2),
        sse: +sse.toFixed(3),
        uMin: +Math.min(...us).toFixed(1), uMax: +Math.max(...us).toFixed(1),
    };
}

/** 运行时双环控制器（供 server.js / 模拟器集成） */
function createControlEngineV2(options = {}) {
    const cfg = Object.assign({}, DEFAULTS, options);
    let speed = options.speed || 0;
    let system = options.system || 'AC';
    const loop = (target, min, max, gains) => ({
        target, min, max, gains: Object.assign({ kp: 1, ki: 0, kd: 0 }, gains),
        integral: 0, dFilt: 0, lastMeas: null, output: target, auto: false, error: 0, measurement: target,
    });
    const loops = {
        force: loop(cfg.fTarget, cfg.forceMin, cfg.forceMax, options.forceGains),
        posture: loop(cfg.hTarget, cfg.heightMin, cfg.heightMax, options.postureGains),
    };
    let pPlant = loops.force.output, hPlant = loops.posture.output;

    function setSpeed(v) {
        speed = Number(v) || 0;
        const t = targetMeanContactForce(speed, { system });
        loops.force.target = t.value;                       // 速度自适应目标
        const bin = cfg.speedBins.find((b) => speed <= b.vMax) || cfg.speedBins[cfg.speedBins.length - 1];
        loops.force.gains = Object.assign({}, loops.force.gains, {
            kp: loops.force.gains.kp * bin.scale / (loops.force._lastScale || 1),
        });
        loops.force._lastScale = bin.scale;
        return t;
    }

    function tick(sensor, mode) {
        const uEffF = loops.force.output, uEffH = loops.posture.output;
        pPlant = plantStep(pPlant, uEffF, cfg.dt, cfg.tauForce);
        hPlant = Math.min(cfg.heightMax, Math.max(cfg.heightMin, plantStep(hPlant, uEffH, cfg.dt, cfg.tauHeight)));
        const pMeas = mode === 'plc' && sensor && sensor.pressure != null ? sensor.pressure : pPlant;
        const fMeas = pMeas * 1000 * cfg.aEff - cfg.fOffset;
        const hMeas = hPlant;
        [['force', fMeas], ['posture', hMeas]].forEach(([k, meas]) => {
            const L = loops[k];
            const e = L.target - meas;
            const dMeas = L.lastMeas === null ? 0 : (meas - L.lastMeas) / cfg.dt;
            L.dFilt = cfg.derivFilterN > 0 ? (cfg.derivFilterN * dMeas + L.dFilt) / (cfg.derivFilterN + 1) : dMeas;
            if (L.auto) {
                const span = Math.abs(L.max - L.min) || 1;
                let out = L.gains.kp * e + L.gains.ki * L.integral - L.gains.kd * L.dFilt;
                let sat = false;
                if (out > L.max) { out = L.max; sat = true; }
                if (out < L.min) { out = L.min; sat = true; }
                const freeze = (Math.abs(e) > cfg.integralSeparation * span)
                    || (sat && ((out >= L.max && e > 0) || (out <= L.min && e < 0)));
                if (!freeze) L.integral += e * cfg.dt;
                L.output = out;
            }
            L.error = e; L.measurement = meas; L.lastMeas = meas;
        });
    }

    function getStatus() {
        return {
            speed, loops: JSON.parse(JSON.stringify(loops)),
            plant: { pressure: pPlant, height: hPlant },
            target: targetMeanContactForce(speed, { system }),
        };
    }
    return { tick, setSpeed, getStatus, config: cfg };
}

/**
 * 推荐预设（由参数扫描确定，见 tests/report.json）：
 *  - 接触力环：安全增益（Z-N×折减）＋不完全微分(N=8)＋积分分离(0.35)＋设定值斜坡 3 N/s
 *      实测：超调 3.7%、12.5～15.5 s 进入 ±2% 带、稳态偏差 0（Z-N 原始参数超调 84%）
 *  - 姿态环：IMC-PI(λ=T)＋不完全微分(N=8)＋积分分离(0.35)＋设定值斜坡 100 mm/s
 *      实测：超调 3.7%、8.5 s 稳定、稳态偏差 0（Z-N 在该通道不可用）
 */
const PRESETS = {
    contactForce: { derivFilterN: 8, integralSeparation: 0.35, rampRate: 3 },
    posture: { derivFilterN: 8, integralSeparation: 0.35, rampRate: 100 },
};

module.exports = {
    DEFAULTS, PRESETS, znGains, imcGains, tuneSafe, simulateClosedLoop, stepMetrics,
    createControlEngineV2, plantStep,
};
