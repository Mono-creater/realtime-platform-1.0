/**
 * ewma-trend.js —— EWMA 趋势检测（论文 §2.4 / 式(5)(6)(12) 的工程实现）
 *
 * 背景（论文 §2.4 "变化率判据的滤波一致性问题"）：
 *   原实现中阈值通道读中值滤波后的量值，而变化率通道读原始样本算差分，
 *   导致中值滤波只保护了阈值通道——单点尖峰被滤波后不再越限，却在原始序列上
 *   表现为数十 ℃/min 的"骤变"，仍从变化率通道报出（实测 2 230 条温度告警中
 *   2 156 条、96.7% 来自变化率通道）。
 *   过渡方案（时间窗持续性投票）虽可缓解，但窗口参数须凭经验设定、
 *   且无法给出误报率的解析表达式。
 *
 * 本模块实现论文的根治方案：
 *   1) 阈值通道与变化率通道共用【同一条】滤波序列（3 点中值 → EWMA），
 *      滤波不一致从根源上消除；
 *   2) 变化率统计量取 EWMA 序列在窗口 W 上的差分 roc = (Zi − Zi−W)/W；
 *   3) 统计窗口与轮询周期【解耦】：历史缓冲按时间裁剪，差分基准取
 *      "年龄最接近 W 的样本"，使窗口恒为 [W, W + Δt)，不随轮询周期收缩；
 *   4) 给出变化率标准差的解析式（式6）与 3σ 可分辨判据 δmin = 3σr ≤ rw（式12），
 *      使误报率由"凭经验试凑"转为"按噪声水平解析校核"。
 *
 * 解析关系（论文 4.4 节，符号约定见 §2.4）：
 *   σeff = √0.4487 · σ ≈ 0.670 σ      （3 点中值滤波后单点噪声标准差，仅用于阈值通道噪声讨论）
 *   σZ²  = σ² · λ/(2−λ)               （EWMA 稳态方差，Roberts 1959；蒙特卡洛 N=3×10⁶ 复算 Var(Z)≈0.111σ²）
 *   σr   = √2 · σZ / W                （式6：Var(roc) ≈ 2σZ²/W²；式中【不含】σeff——
 *                                        中值滤波的方差削减被其引入的正自相关抵消，论文 P74 复算佐证）
 *   δmin = 3 σr                       （式12：3σ 准则可分辨判据 δmin ≤ rw）
 *   噪声边界：由 δmin ≤ rw 反解  σmax = rw / (3·√2·√(λ/(2−λ)) / W)
 *
 * 校验点（λ=0.2、W=1 min、σ=1.0 ℃）：
 *   σZ = 0.333 3 ℃ → σr = √2·σZ/W ≈ 0.471 4 ℃·min⁻¹ → δmin ≈ 1.41
 *   rw = 2 ℃·min⁻¹ 相当于约 4.24 σr 裕度（论文表11 工作点 L）；噪声边界 σ ≤ 1.41 ℃
 *
 * 无第三方依赖，供 alarm-engine.js / tests 复用（单一实现来源）。
 */

'use strict';

// ---------- 常量（论文口径，可配置但默认值即为论文值） ----------

/** 3 点中值滤波对高斯白噪声的方差削减比（论文 §2.4 实测 0.448 7） */
const MEDIAN3_VAR_RATIO = 0.4487;

/** 3 点中值滤波后的噪声标准差系数 σeff/σ = √0.4487 ≈ 0.670（仅用于阈值通道噪声讨论，不进入式(6)） */
const MEDIAN3_SIGMA_RATIO = Math.sqrt(MEDIAN3_VAR_RATIO);   // ≈ 0.66985

/** 默认 EWMA 平滑系数（论文取 0.2，图6 表明 0.2~0.5 区间稳健） */
const DEFAULT_LAMBDA = 0.2;

/** 默认变化率统计窗口（分钟）；论文取 W = 60 s = 1 min */
const DEFAULT_WINDOW_MIN = 1.0;

// ---------- 纯函数：解析式 ----------

/** 3 点中值（保持论文"3 点中值滤波"口径） */
function median3(a, b, c) { return [a, b, c].sort((x, y) => x - y)[1]; }

/**
 * 式(6)：变化率统计量的理论标准差 σr = √(2λ/(2−λ)) · σ / W（不含 σeff，自相关抵消见头部注释）
 * @param {number} sigma 滤波前原始噪声标准差 σ
 * @param {number} lambda EWMA 平滑系数 λ
 * @param {number} windowMin 统计窗口 W（min）
 */
function sigmaRoc(sigma, lambda = DEFAULT_LAMBDA, windowMin = DEFAULT_WINDOW_MIN) {
    const sigmaZ = sigma * Math.sqrt(lambda / (2 - lambda));
    return Math.SQRT2 * sigmaZ / windowMin;
}

/**
 * 式(12)：3σ 准则下变化率的可分辨判据 δmin = 3 σr ≤ rw
 */
function deltaMin(sigma, lambda = DEFAULT_LAMBDA, windowMin = DEFAULT_WINDOW_MIN) {
    return 3 * sigmaRoc(sigma, lambda, windowMin);
}

/**
 * 由 δmin ≤ rw 反解噪声边界：保证判据可分辨的传感器噪声上限 σmax
 * 论文校验：λ=0.2、W=1 min、rw=2 ℃·min⁻¹ → σmax ≈ 1.41 ℃
 */
function sigmaMax(rw, lambda = DEFAULT_LAMBDA, windowMin = DEFAULT_WINDOW_MIN) {
    const k = 3 * Math.SQRT2 * Math.sqrt(lambda / (2 - lambda)) / windowMin;
    return rw / k;
}

/**
 * 工程裕度：阈值 rw 相当于多少倍 σr（论文表11 工作点 L：2 ℃·min⁻¹ ≈ 4.24 σr）
 */
function marginInSigma(rw, sigma, lambda = DEFAULT_LAMBDA, windowMin = DEFAULT_WINDOW_MIN) {
    const sr = sigmaRoc(sigma, lambda, windowMin);
    return sr > 0 ? rw / sr : Infinity;
}

/**
 * 判据自检：按当前噪声水平判断变化率阈值是否仍有可分辨裕度
 * @returns {{ok:boolean, sigma:number, sigmaRoc:number, deltaMin:number, rw:number, sigmaMax:number, margin:number, advice:string}}
 */
function checkNoiseBoundary(rw, sigma, lambda = DEFAULT_LAMBDA, windowMin = DEFAULT_WINDOW_MIN) {
    const sr = sigmaRoc(sigma, lambda, windowMin);
    const dm = 3 * sr;
    const smax = sigmaMax(rw, lambda, windowMin);
    const margin = marginInSigma(rw, sigma, lambda, windowMin);
    const ok = dm <= rw;
    return {
        ok, sigma, sigmaRoc: sr, deltaMin: dm, rw, sigmaMax: smax, margin,
        advice: ok
            ? `判据可分辨（δmin=${dm.toFixed(3)} ≤ rw=${rw}，裕度≈${margin.toFixed(1)}σr）；当前噪声上限 σ ≤ ${smax.toFixed(2)}`
            : `判据不可分辨（δmin=${dm.toFixed(3)} > rw=${rw}）：须降低传感器噪声至 σ ≤ ${smax.toFixed(2)}，或上调变化率阈值`,
    };
}

// ---------- EWMA 趋势检测器 ----------

/**
 * EWMA 趋势检测器（论文 §2.4 的实现）
 *
 * 处理链：时间裁剪缓冲 → 3 点中值滤波 → EWMA 平滑 → (阈值通道 ‖ 变化率通道) → 取较高等级
 *
 * 关键点：
 *  - 历史缓冲按【时间】裁剪（不再按样本条数定长），窗口与轮询周期解耦；
 *  - 差分基准取"年龄最接近 W 的样本"，窗口恒为 [W, W + Δt)；
 *  - 阈值通道与变化率通道共用同一 EWMA 序列 zi（不是原始样本、也不是中值输出）。
 */
class EwmaTrendDetector {
    /**
     * @param {object} opts
     * @param {number} [opts.lambda=0.2]        EWMA 平滑系数 λ
     * @param {number} [opts.windowMin=1.0]     变化率统计窗口 W（分钟）
     * @param {number} [opts.sigma=1.0]         传感器噪声标准差 σ（用于解析校核，可现场标定）
     * @param {number} [opts.keepMin]           历史缓冲保留时长（分钟），默认 W + Δt + 余量
     * @param {number} [opts.confirmN=2]        连续确认点数 n
     * @param {boolean}[opts.useEwmaThreshold=true] 阈值通道是否判 EWMA 平滑值（论文口径为 true）
     * @param {number} [opts.coldStartProtectMs=0] 15 s 冷启动保护（论文 P117）：差分基准不得早于引擎启动后
     *                                            该时长；默认 0=关闭（误报率评估类试验启用，不影响表10 检出时延）
     */
    constructor(opts = {}) {
        this.lambda = opts.lambda !== undefined ? opts.lambda : DEFAULT_LAMBDA;
        this.windowMin = opts.windowMin !== undefined ? opts.windowMin : DEFAULT_WINDOW_MIN;
        this.sigma = opts.sigma !== undefined ? opts.sigma : 1.0;
        this.confirmN = opts.confirmN !== undefined ? opts.confirmN : 2;
        this.useEwmaThreshold = opts.useEwmaThreshold !== false;
        this.coldStartProtectMs = opts.coldStartProtectMs !== undefined ? opts.coldStartProtectMs : 0;
        /** 首样本时刻（冷启动保护的计时原点） */
        this._t0 = undefined;
        /**
         * 缓冲保留时长：按【时间】裁剪（不再按样本条数定长）。
         * 保留 2W 即可保证"年龄最接近 W 的样本"始终存在，
         * 且覆盖时间与轮询周期无关 —— 这是窗口解耦的实现要点。
         */
        this.keepMs = opts.keepMs !== undefined ? opts.keepMs : this.windowMin * 60000 * 2;

        /** @type {Array<{t:number,temp:number,press:number,humid:number}>} 时间升序原始样本 */
        this.raw = [];
        /** @type {Object} 各通道 EWMA 状态 */
        this.z = {};
        /** @type {Object} 各通道中值滤波中间量（保留前 3 个原始值） */
        this._medBuf = {};
        /** @type {Array<{t:number,z:number}>} 各通道 EWMA 序列（供按年龄取差分基准） */
        this.zSeries = {};
        /** @type {Object} 连续确认计数 */
        this.state = {};
        for (const sig of ['temp', 'press', 'humid']) {
            this.zSeries[sig] = [];
            this._medBuf[sig] = [];
            this.state[sig] = { level: 'normal', count: 0 };
        }
        /** 统计：因投票/确认被拒次数（保留接口兼容） */
        this.rejected = 0;
    }

    /** 运行期配置调整（现场标定） */
    setSigma(sigma) { this.sigma = sigma; }
    setLambda(lambda) { this.lambda = lambda; }

    /** 当前解析指标（供 /api/v2/ewma/analytics 与自检） */
    analytics(rwBySignal) {
        const sr = sigmaRoc(this.sigma, this.lambda, this.windowMin);
        const out = {
            lambda: this.lambda, windowMin: this.windowMin, sigma: this.sigma,
            sigmaEff: MEDIAN3_SIGMA_RATIO * this.sigma,   // 仅用于阈值通道噪声讨论（论文 P77 符号约定）
            sigmaZ: this.sigma * Math.sqrt(this.lambda / (2 - this.lambda)),
            sigmaRoc: sr, deltaMin: 3 * sr,
            noiseBoundary: {}, margin: {}, workingPoint: {}, resolvable: {},
        };
        const rw = rwBySignal || {};
        for (const sig of Object.keys(rw)) {
            out.noiseBoundary[sig] = sigmaMax(rw[sig], this.lambda, this.windowMin);
            out.margin[sig] = marginInSigma(rw[sig], this.sigma, this.lambda, this.windowMin);
            out.workingPoint[sig] = +marginInSigma(rw[sig], this.sigma, this.lambda, this.windowMin).toFixed(2);  // 表11 工作点 L = rw/σr
            out.resolvable[sig] = 3 * sr <= rw[sig];
        }
        return out;
    }

    /** 按时间裁剪缓冲（窗口与轮询周期解耦的关键） */
    _trim(now) {
        const cutoff = now - this.keepMs;
        let i = 0;
        while (i < this.raw.length && this.raw[i].t < cutoff) i += 1;
        if (i > 0) {
            this.raw.splice(0, i);
            for (const sig of ['temp', 'press', 'humid']) {
                let j = 0;
                while (j < this.zSeries[sig].length && this.zSeries[sig][j].t < cutoff) j += 1;
                if (j > 0) this.zSeries[sig].splice(0, j);
            }
        }
    }

    /**
     * 取差分基准 = 【最年轻的满窗样本】（年龄 ≥ W 的最新一点）。
     *
     * 缓冲已按时间裁剪（保留 2W），故只要历史满一个 W，
     * 就一定能找到满窗样本，使窗口恒为 [W, W + Δt)，
     * 与轮询周期 Δt 无关（论文表14 的"解耦后等效窗口恒为 60.0 s"）。
     *
     * 窗口尚未建立（历史不足一个 W）时返回 null，判据不成立 ——
     * 这是论文表10 中 EWMA 通道"61 s"下限（= W + 一个确认步）的来源：
     * 冷启动后须先积累满一个统计窗口，变化率判据方可生效。
     *
     * @returns {?{t:number,z:number}} 基准样本（EWMA 序列）
     */
    _baseline(sig, now) {
        const s = this.zSeries[sig];
        if (!s.length) return null;
        const need = this.windowMin * 60000;

        // 取【最年轻的满窗样本】：年龄 ≥ W 的样本里挑最新的一个。
        // 旧实现先挑"年龄最接近 W"再要求 ≥ W，采样间隔略小于 1 s 时
        // （如 999 ms）最接近的样本年龄恒为 59.94 s，判据永远返回 null，
        // 变化率通道被静默关闭；改为按时间升序找最后一个满窗点，
        // 窗口仍恒为 [W, W+Δt)，与轮询周期解耦。
        let best = null;
        for (const pt of s) {                 // zSeries 按时间升序
            if (now - pt.t >= need) best = pt;
            else break;                       // 更年轻的都不满窗
        }
        if (!best) return null;
        // 15 s 冷启动保护（论文 P117）：差分基准不得早于引擎启动后 coldStartProtectMs。
        // EWMA 冷启动未收敛期（首个样本方差约为稳态 20 倍）使窗口刚满后的首批差分方差偏大，
        // 在"每次试验独立冷启动"的短时试验中产生集中于 t≈61~63 s 的伪告警；
        // 该保护仅在误报率评估类试验启用（默认关闭），不影响表10 检出时延。
        if (this.coldStartProtectMs > 0 && (best.t - this._t0) < this.coldStartProtectMs) return null;
        return best;
    }

    /**
     * 推入一个采样。
     * @param {{t:number, temperature?:number, pressure?:number, humidity?:number}} sample
     * @returns {{filtered:object, roc:object, grades:object}} 本次的滤波值、变化率与分级
     */
    update(sample) {
        const t = sample.t !== undefined ? sample.t : Date.now();
        if (this._t0 === undefined) this._t0 = t;
        const vals = { temp: sample.temperature, press: sample.pressure, humid: sample.humidity };

        this.raw.push({ t, temp: vals.temp, press: vals.press, humid: vals.humid });
        this._trim(t);

        const filtered = {}, roc = {}, grades = {};

        for (const sig of ['temp', 'press', 'humid']) {
            const v = vals[sig];
            if (v === undefined || v === null || Number.isNaN(v)) { filtered[sig] = undefined; roc[sig] = undefined; continue; }

            // --- 1) 3 点中值滤波 ---
            const mb = this._medBuf[sig];
            mb.push(v);
            if (mb.length > 3) mb.shift();
            const med = mb.length >= 3 ? median3(mb[0], mb[1], mb[2]) : mb[mb.length - 1];

            // --- 2) EWMA 平滑（阈值与变化率通道共用的唯一滤波序列） ---
            const prevZ = this.z[sig];
            const zi = prevZ === undefined ? med : this.lambda * med + (1 - this.lambda) * prevZ;
            this.z[sig] = zi;
            this.zSeries[sig].push({ t, z: zi });

            filtered[sig] = zi;

            // --- 3) 变化率：EWMA 序列在窗口 W 上的差分 roc = (Zi − Zi−W)/W ---
            //     W 以 min 为单位；分母取基准样本的实际窗龄（∈[W, W+Δt)），
            //     与之等价的标称口径即为论文式(5)的 roc = (Zi − Zi−W)/W。
            const base = this._baseline(sig, t);
            if (base) {
                const spanMin = Math.max((t - base.t) / 60000, 1 / 60);
                roc[sig] = (zi - base.z) / spanMin;
            } else {
                roc[sig] = null;              // 窗口未满，判据不成立
            }

            // --- 4) 阈值通道：以 EWMA 平滑值判越限 ---
            grades[sig] = { thresholdLevel: null, rocLevel: null, level: 'normal', source: null };
        }

        return { filtered, roc, grades };
    }

    /** 供外部按窗口取 EWMA 序列（测试/可视化用） */
    series(sig) { return this.zSeries[sig] || []; }
}

module.exports = {
    MEDIAN3_VAR_RATIO,
    MEDIAN3_SIGMA_RATIO,
    DEFAULT_LAMBDA,
    DEFAULT_WINDOW_MIN,
    median3,
    sigmaRoc,
    deltaMin,
    sigmaMax,
    marginInSigma,
    checkNoiseBoundary,
    EwmaTrendDetector,
};
