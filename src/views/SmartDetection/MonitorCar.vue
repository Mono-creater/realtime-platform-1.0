<template>
  <div class="cockpit">
    <!-- ===== 顶部状态条 ===== -->
    <header class="ck-head">
      <div class="ck-title">
        <span class="ck-h1">控制台</span>
        <span class="ck-sub">双环 PID · 接触力 / 弓头高度</span>
        <span class="ck-status" :class="statusClass">{{ statusText }}</span>
        <span v-if="sourceText" class="ck-tag" :class="'src-' + dataSource">{{ sourceText }}</span>
        <span v-if="packetSeq !== null" class="ck-tag">seq={{ packetSeq }}</span>
      </div>
      <div class="ck-actions">
        <el-button size="small" :type="mode === 'simulation' ? 'warning' : 'primary'" @click="toggleMode" :loading="modeLoading">
          {{ mode === 'simulation' ? '模拟模式' : '真实模式' }}
        </el-button>
        <el-button v-if="mode === 'simulation'" size="small" :type="simulationPaused ? 'success' : 'info'" @click="togglePause" :loading="pauseLoading">
          {{ simulationPaused ? '继续' : '暂停' }}
        </el-button>
        <span class="ck-time">{{ currentTime }}</span>
      </div>
    </header>

    <!-- ===== KPI：三大被控量 + 力环误差 ===== -->
    <section class="ck-kpis">
      <div class="ck-kpi" style="--c:#00c6ff">
        <div class="k-label">接触力</div>
        <div class="k-value">{{ fmtForce }}<small>N</small></div>
        <div class="k-foot">目标 {{ forceParams.target }} N · EN 50367 70–120 N</div>
        <div class="k-bar"><i :style="{ width: forcePct + '%', background: forceOk ? '#00d68f' : '#ff3d71' }"></i></div>
      </div>
      <div class="ck-kpi" style="--c:#00d68f">
        <div class="k-label">弓头高度</div>
        <div class="k-value">{{ fmtHeight }}<small>mm</small></div>
        <div class="k-foot">目标 {{ postureParams.target }} mm · 行程 1000–2600</div>
        <div class="k-bar"><i :style="{ width: heightPct + '%', background: '#00d68f' }"></i></div>
      </div>
      <div class="ck-kpi" style="--c:#ffaa00">
        <div class="k-label">气囊压力</div>
        <div class="k-value">{{ fmtAirPress }}<small>kPa</small></div>
        <div class="k-foot">执行机构输出 · 与接触力分属不同量纲</div>
        <div class="k-bar"><i :style="{ width: airPct + '%', background: '#ffaa00' }"></i></div>
      </div>
      <div class="ck-kpi" :style="{ '--c': forceErrOk ? '#00d68f' : '#ff3d71' }">
        <div class="k-label">力环跟踪误差</div>
        <div class="k-value">{{ fmtForceErr }}<small>N</small></div>
        <div class="k-foot">误差限 ±{{ loopDefs[0].errorLimit }} N · {{ forceErrOk ? '在限内' : '超限' }}</div>
        <div class="k-bar"><i :style="{ width: forceErrPct + '%', background: forceErrOk ? '#00d68f' : '#ff3d71' }"></i></div>
      </div>
    </section>

    <!-- ===== 双环 + 姿态 ===== -->
    <section class="ck-main">
      <div class="ck-loop" v-for="loop in loopDefs" :key="loop.key">
        <div class="loop-head">
          <span class="loop-title">{{ loop.title }}</span>
          <span v-if="tuneInfo && tuneInfo.recovering && tuneInfo.loop === loop.key" class="recover-tag">
            恢复工作点 {{ tuneInfo.recoverLeftS }}s
          </span>
          <el-switch v-model="loop.params.auto" active-text="自动" @change="toggleAuto(loop.key, $event)" />
        </div>

        <div class="loop-nums">
          <div class="ln">
            <span class="ln-label">目标</span>
            <span class="ln-value">{{ loop.target.toFixed(0) }}<small>{{ loop.targetUnit }}</small></span>
          </div>
          <div class="ln">
            <span class="ln-label">测量</span>
            <span class="ln-value" :style="{ color: loop.measureColor }">{{ loop.measurement.toFixed(1) }}<small>{{ loop.measureUnit }}</small></span>
          </div>
          <div class="ln">
            <span class="ln-label">误差</span>
            <span class="ln-value" :style="{ color: Math.abs(loop.error) > loop.errorLimit ? '#ff3d71' : '#00d68f' }">
              {{ loop.error.toFixed(1) }}<small>{{ loop.measureUnit }}</small>
            </span>
          </div>
          <div class="ln">
            <span class="ln-label">输出</span>
            <span class="ln-value">{{ loop.output.toFixed(0) }}<small>{{ loop.outputUnit }}</small></span>
          </div>
        </div>

        <div class="loop-params">
          <label>Kp<el-input-number v-model="loop.params.kp" :min="0" :max="100" :step="0.1" size="small" controls-position="right" @change="onPidChange(loop.key)" /></label>
          <label>Ki<el-input-number v-model="loop.params.ki" :min="0" :max="50" :step="0.05" size="small" controls-position="right" @change="onPidChange(loop.key)" /></label>
          <label>Kd<el-input-number v-model="loop.params.kd" :min="0" :max="50" :step="0.05" size="small" controls-position="right" @change="onPidChange(loop.key)" /></label>
          <label>目标<el-input-number v-model="loop.params.target" :min="0" :max="loop.key === 'force' ? 1000 : 2600" :step="1" size="small" controls-position="right" @change="onPidChange(loop.key)" /></label>
        </div>

        <div class="loop-tune">
          <el-button size="small" type="primary" plain :disabled="tuneBusy !== null && tuneBusy !== loop.key" :loading="tuneLoading && tuneBusy === loop.key" @click="startTune(loop.key)">
            Z-N 阶跃整定
          </el-button>
          <el-button v-if="tuneInfo && tuneInfo.loop === loop.key && tuneInfo.state === 'sampling'" size="small" type="danger" plain @click="cancelTune">取消</el-button>
          <el-progress v-if="tuneInfo && tuneInfo.loop === loop.key && tuneInfo.state === 'sampling'" :percentage="tuneInfo.progressPct" :stroke-width="5" class="tune-progress" />
        </div>

        <!-- 整定结果条：成功=绿色收敛摘要；未收敛=琥珀色回退说明（不再出现"整定失败"红字） -->
        <div v-if="tuneInfo && tuneInfo.loop === loop.key && tuneInfo.state === 'done' && tuneInfo.result" class="tune-result ok">
          <span class="tr-title">已收敛</span>
          <span class="tr-item">阶跃超调 {{ tuneInfo.result.overshootPct ?? '—' }}%</span>
          <span class="tr-item">调节 {{ tuneInfo.result.settleS ?? '—' }} s</span>
          <span class="tr-item">方法 {{ tuneInfo.result.method }}</span>
          <span class="tr-gains">Kp {{ tuneInfo.result.kp.toFixed(2) }} · Ki {{ tuneInfo.result.ki.toFixed(2) }} · Kd {{ tuneInfo.result.kd.toFixed(2) }}</span>
        </div>
        <div v-else-if="tuneInfo && tuneInfo.loop === loop.key && tuneInfo.state === 'failed'" class="tune-result fallback">
          <span class="tr-title">整定回退</span>
          <span class="tr-item">阶跃辨识未达精度，已自动采用 IMC-PI 参数并写入</span>
          <span class="tr-gains">Kp {{ loop.params.kp.toFixed(2) }} · Ki {{ loop.params.ki.toFixed(2) }} · Kd {{ loop.params.kd.toFixed(2) }}</span>
        </div>
        <div v-else-if="tuneInfo && tuneInfo.loop === loop.key && tuneInfo.state === 'cancelled'" class="tune-result fallback">
          <span class="tr-title">已取消</span><span class="tr-item">参数保持整定前数值</span>
        </div>
      </div>

      <!-- 受电弓姿态 -->
      <div class="ck-posture">
        <div class="loop-head"><span class="loop-title">受电弓姿态</span><span class="ck-mini">两连杆正运动学</span></div>
        <svg viewBox="0 0 300 225" class="pose-svg">
          <line x1="0" :y1="poseGeo.ty - 16" x2="300" :y2="poseGeo.ty - 16" stroke="#8fa6bd" stroke-width="2" stroke-dasharray="8,4" />
          <rect :x="poseGeo.tx - 36" :y="poseGeo.ty - 16" width="72" height="11" rx="5" fill="#f0c040" stroke="#c90" stroke-width="1.5" />
          <rect :x="poseGeo.ox - 20" :y="poseGeo.oy" width="40" height="10" rx="3" fill="#555" />
          <line :x1="poseGeo.ox" :y1="poseGeo.oy" :x2="poseGeo.jx" :y2="poseGeo.jy" stroke="#ccc" stroke-width="6" stroke-linecap="round" />
          <line :x1="poseGeo.jx" :y1="poseGeo.jy" :x2="poseGeo.tx" :y2="poseGeo.ty" stroke="#ddd" stroke-width="5" stroke-linecap="round" />
          <circle :cx="poseGeo.ox" :cy="poseGeo.oy" r="4" fill="#00c6ff" />
          <circle :cx="poseGeo.jx" :cy="poseGeo.jy" r="4" fill="#00c6ff" />
          <circle :cx="poseGeo.tx" :cy="poseGeo.ty" r="4" fill="#ffaa00" />
          <path :d="arcPath(poseGeo.ox, poseGeo.oy, 32, poseGeo.th1)" fill="none" stroke="#00c6ff" stroke-width="1.5" />
          <text :x="poseGeo.ox + 40" :y="poseGeo.oy - 6" fill="#00c6ff" font-size="11">θ1 {{ fmtTheta1 }}°</text>
          <path :d="arcPath(poseGeo.jx, poseGeo.jy, 24, poseGeo.th2)" fill="none" stroke="#ffaa00" stroke-width="1.5" />
          <text :x="poseGeo.jx + 30" :y="poseGeo.jy - 6" fill="#ffaa00" font-size="11">θ2 {{ fmtTheta2 }}°</text>
        </svg>
        <div class="pose-foot">H = L1·sinθ1 + L2·sinθ2（θ2 = r·θ1）</div>
      </div>
    </section>

    <!-- ===== 双环收敛曲线 ===== -->
    <section class="ck-card">
      <div class="ck-card-head">
        <span>双环收敛曲线</span>
        <span class="ck-mini">左轴 接触力 N · 右轴 弓头高度 mm · 虚线为目标值</span>
      </div>
      <div ref="convRef" class="conv-chart"></div>
    </section>

    <!-- ===== 环境参数 ===== -->
    <section class="ck-env">
      <div class="ck-card env-side">
        <div class="ck-card-head"><span>环境参数</span><span class="ck-mini">PLC 采集</span></div>
        <div class="env-grid">
          <div class="env-item" v-for="s in sensors" :key="s.name" :class="{ alarm: sensorAlarm[s.name] }">
            <div class="e-label">{{ s.label }}</div>
            <div class="e-value" :style="{ color: sensorAlarm[s.name] ? '#ff3d71' : s.color }">{{ s.value }}<small>{{ s.unit }}</small></div>
            <div class="e-bar"><i :style="{ width: s.percent + '%', background: sensorAlarm[s.name] ? '#ff3d71' : s.color }"></i></div>
          </div>
        </div>
        <div class="env-note">环境量只作 PID 整定的过程数据，不参与碳滑板健康度扣减。</div>
      </div>
      <div class="ck-card env-chart">
        <div class="ck-card-head"><span>环境趋势</span><span class="ck-mini">最近 {{ trendData.length }} 点</span></div>
        <div ref="trendRef" class="trend-chart"></div>
      </div>
    </section>

    <div class="ck-foot">
      公式依据：Ziegler-Nichols 阶跃整定（Trans. ASME 64:759-768, 1942）· 接触力-气囊力平衡（EN 50367:2012，静态 70–120 N）·
      位置式并联 PID 微分先行（Åström & Hägglund, ISA 1995）· 两连杆正运动学（Craig）
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import echarts from '@/utils/echarts'
import api from '@/utils/api'
import socket from '@/socket'

/* ================= 状态 ================= */
const currentTime = ref('')
const statusText = ref('连接中')
const statusClass = ref('connecting')
const mode = ref('real')
const modeLoading = ref(false)
const simulationPaused = ref(false)
const pauseLoading = ref(false)

const sensors = ref([
  { name: 'temperature', label: '温度', value: 0, unit: '°C', color: '#00d68f', percent: 0 },
  { name: 'pressure', label: '压力', value: 0, unit: 'kPa', color: '#ffaa00', percent: 0 },
  { name: 'humidity', label: '湿度', value: 0, unit: '%', color: '#2ca7e0', percent: 0 },
])
const sensorAlarm = ref({})
const dataSource = ref('')
const packetSeq = ref(null)
const subPacketTag = ref('')
const sourceText = computed(() => {
  if (dataSource.value === 'plc') return 'PLC 实时'
  if (dataSource.value === 'fallback') return 'PLC 回退'
  if (dataSource.value === 'simulation') return '模拟数据'
  return ''
})

const trendData = ref([])
const trendRef = ref(null)
let trendChart = null

const control = ref(null)
const forceParams = ref({ kp: 1.5, ki: 0.5, kd: 0.5, target: 100, auto: false })
const postureParams = ref({ kp: 0.3, ki: 0.12, kd: 0.05, target: 2400, auto: false })
let lastEditAt = 0

/* ================= 派生量 ================= */
const fmtForce = computed(() => (control.value ? control.value.computed.contactForce.toFixed(1) : '—'))
const fmtHeight = computed(() => (control.value ? Math.round(control.value.computed.height) : '—'))
const fmtAirPress = computed(() => (control.value ? control.value.computed.airPressure.toFixed(1) : '—'))
const fmtTheta1 = computed(() => (control.value ? control.value.computed.theta1.toFixed(1) : '—'))
const fmtTheta2 = computed(() => (control.value ? control.value.computed.theta2.toFixed(1) : '—'))
const fmtForceErr = computed(() => (control.value ? Math.abs(control.value.loops.force.error).toFixed(1) : '—'))

const forceOk = computed(() => {
  const v = control.value ? control.value.computed.contactForce : null
  return v === null ? true : v >= 70 && v <= 120
})
const forceErrOk = computed(() => {
  const e = control.value ? Math.abs(control.value.loops.force.error) : 0
  return e <= 5
})
// 统一钳位：control 尚未到达时 fmt 为 '—'，Number('—') = NaN，直接算宽度会得到 NaN%
function pctOf(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, ((n - lo) / (hi - lo)) * 100))
}
const forcePct = computed(() => pctOf(fmtForce.value, 40, 140))
const heightPct = computed(() => pctOf(fmtHeight.value, 1000, 2600))
const airPct = computed(() => pctOf(fmtAirPress.value, 0, 400))
const forceErrPct = computed(() => pctOf(fmtForceErr.value, 0, 15))

const loopDefs = computed(() => {
  const c = control.value
  return [
    {
      key: 'force', title: '接触力环', params: forceParams.value,
      targetUnit: 'N', measureUnit: 'N', outputUnit: 'kPa', errorLimit: 5,
      target: forceParams.value.target,
      measurement: c ? c.loops.force.measurement : 0,
      output: c ? c.loops.force.output : 0,
      error: c ? c.loops.force.error : 0,
      measureColor: c && (c.loops.force.measurement < 70 || c.loops.force.measurement > 120) ? '#ff3d71' : '#00d68f',
    },
    {
      key: 'posture', title: '姿态环', params: postureParams.value,
      targetUnit: 'mm', measureUnit: 'mm', outputUnit: 'mm', errorLimit: 10,
      target: postureParams.value.target,
      measurement: c ? c.loops.posture.measurement : 0,
      output: c ? c.loops.posture.output : 0,
      error: c ? c.loops.posture.error : 0,
      measureColor: '#00d68f',
    },
  ]
})

const tuneInfo = computed(() => (control.value && control.value.tune) || null)
const tuneBusy = computed(() => (tuneInfo.value && tuneInfo.value.state === 'sampling' ? tuneInfo.value.loop : null))
const tuneLoading = ref(false)

/* ================= 姿态几何 ================= */
const poseGeo = computed(() => {
  const th1 = control.value ? control.value.computed.theta1 : 0
  const th2 = control.value ? control.value.computed.theta2 : 0
  const a1 = (th1 * Math.PI) / 180
  const a2 = (th2 * Math.PI) / 180
  // 比例：按最大弓高 2500 mm 映射到 225 px 画布，留出顶部余量，避免高弓位被裁掉
  const L1 = 86, L2 = 93
  const ox = 150, oy = 200
  const jx = ox + L1 * Math.cos(a1)
  const jy = oy - L1 * Math.sin(a1)
  const tx = jx + L2 * Math.cos(a2)
  const ty = jy - L2 * Math.sin(a2)
  return { th1, th2, ox, oy, jx, jy, tx, ty }
})

function arcPath(cx, cy, r, angDeg) {
  const a = (angDeg * Math.PI) / 180
  const x1 = cx + r, y1 = cy
  const x2 = cx + r * Math.cos(a), y2 = cy - r * Math.sin(a)
  const large = angDeg > 180 ? 1 : 0
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`
}

/* ================= 时间与传感器 ================= */
function updateTime() {
  currentTime.value = new Date().toLocaleString('zh-CN', { hour12: false })
}

const ANOMALY_TO_SENSOR = {
  高温预警: 'temperature', 低温预警: 'temperature',
  高压报警: 'pressure', 低压报警: 'pressure',
  高湿预警: 'humidity',
}

function updateSensors(data) {
  const alarm = { temperature: null, pressure: null, humidity: null }
  for (const a of (data.anomalies || [])) {
    const name = ANOMALY_TO_SENSOR[a.type]
    if (name) alarm[name] = a
  }
  sensorAlarm.value = alarm
  sensors.value.forEach((s) => {
    const val = data[s.name]
    if (val !== undefined && val !== null) {
      s.value = typeof val === 'number' ? val.toFixed(1) : val
      let pct = 0
      if (s.name === 'temperature') pct = ((val + 20) / 120) * 100
      else if (s.name === 'pressure') pct = (val / 1200) * 100
      else if (s.name === 'humidity') pct = val
      s.percent = Math.min(100, Math.max(0, Math.round(pct)))
    }
  })
}

/* ================= 收敛曲线 ================= */
const convRef = ref(null)
let convChart = null
const loopHistory = ref([])

function pushLoopHistory(c) {
  if (!c) return
  loopHistory.value.push({
    t: Date.now(),
    force: c.loops.force.measurement,
    posture: c.loops.posture.measurement,
  })
  if (loopHistory.value.length > 150) loopHistory.value.shift()
}

function renderConvChart() {
  if (!convChart) return
  const h = loopHistory.value
  const labels = h.map((p) => {
    const d = new Date(p.t)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  })
  convChart.setOption({
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(10,30,50,0.92)', borderColor: '#00c6ff', textStyle: { color: '#fff' } },
    legend: { top: 0, data: ['接触力', '高度', '力目标', '高度目标'], textStyle: { color: '#b0c4de' } },
    grid: { left: 46, right: 52, top: 34, bottom: 20 },
    xAxis: { type: 'category', data: labels, axisLabel: { color: '#8fa6bd', fontSize: 10 }, axisLine: { lineStyle: { color: '#2a4a6a' } } },
    yAxis: [
      { type: 'value', name: 'N', min: 40, max: 140, axisLabel: { color: '#00c6ff', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } }, nameTextStyle: { color: '#00c6ff' } },
      { type: 'value', name: 'mm', min: 1000, max: 2600, axisLabel: { color: '#00d68f', fontSize: 10 }, splitLine: { show: false }, nameTextStyle: { color: '#00d68f' } },
    ],
    series: [
      { name: '接触力', type: 'line', data: h.map((p) => p.force), smooth: true, symbol: 'none', lineStyle: { color: '#00c6ff', width: 2 } },
      { name: '高度', type: 'line', yAxisIndex: 1, data: h.map((p) => p.posture), smooth: true, symbol: 'none', lineStyle: { color: '#00d68f', width: 2 } },
      { name: '力目标', type: 'line', data: h.map(() => forceParams.value.target), symbol: 'none', lineStyle: { color: '#00c6ff', width: 1, type: 'dashed', opacity: 0.6 } },
      { name: '高度目标', type: 'line', yAxisIndex: 1, data: h.map(() => postureParams.value.target), symbol: 'none', lineStyle: { color: '#00d68f', width: 1, type: 'dashed', opacity: 0.6 } },
    ],
  })
  convChart.resize()
}

/* ================= 环境趋势 ================= */
function updateTrendChart() {
  if (!trendChart) return
  const dates = trendData.value.map((d) => d.timestamp.slice(11, 19))
  trendChart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['温度', '压力', '湿度'], textStyle: { color: '#b0c4de' }, top: 0 },
    grid: { left: 42, right: 44, top: 30, bottom: 22 },
    xAxis: { type: 'category', data: dates, axisLabel: { color: '#8fa6bd', fontSize: 10 }, boundaryGap: false },
    yAxis: [
      { type: 'value', name: '°C', axisLabel: { color: '#8fa6bd', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } }, nameTextStyle: { color: '#8fa6bd' } },
      { type: 'value', name: 'kPa', axisLabel: { color: '#8fa6bd', fontSize: 10 }, splitLine: { show: false }, nameTextStyle: { color: '#8fa6bd' } },
    ],
    series: [
      { name: '温度', type: 'line', data: trendData.value.map((d) => d.temperature), smooth: true, symbol: 'none', lineStyle: { color: '#00d68f' } },
      { name: '压力', type: 'line', yAxisIndex: 1, data: trendData.value.map((d) => d.pressure), smooth: true, symbol: 'none', lineStyle: { color: '#ffaa00' } },
      { name: '湿度', type: 'line', data: trendData.value.map((d) => d.humidity), smooth: true, symbol: 'none', lineStyle: { color: '#2ca7e0' } },
    ],
  }, true)
  trendChart.resize()
}

/* ================= PID 交互 ================= */
function syncControlToParams() {
  const c = control.value
  if (!c || Date.now() - lastEditAt < 3000) return
  for (const [key, target] of [['force', forceParams], ['posture', postureParams]]) {
    const l = c.loops[key]
    target.value = { kp: l.kp, ki: l.ki, kd: l.kd, target: l.target, auto: l.auto }
  }
}

const paramTimers = {}
function onPidChange(loop) {
  lastEditAt = Date.now()
  if (paramTimers[loop]) clearTimeout(paramTimers[loop])
  paramTimers[loop] = setTimeout(async () => {
    const p = loop === 'force' ? forceParams.value : postureParams.value
    try {
      const res = await api.post('/api/control/params', { loop, kp: p.kp, ki: p.ki, kd: p.kd, target: p.target })
      applyControl(res.data.status)
      ElMessage.success(`${loop === 'force' ? '接触力环' : '姿态环'}参数已更新`)
    } catch (err) {
      ElMessage.error('参数更新失败: ' + (err.response?.data?.error || err.message))
      await refreshControl()
    }
  }, 300)
}

function applyControl(status) {
  if (!status) return
  control.value = status
  lastEditAt = 0
  syncControlToParams()
}

async function refreshControl() {
  try {
    const res = await api.get('/api/control/status')
    control.value = res.data
    lastEditAt = 0
    syncControlToParams()
  } catch (err) {
    console.warn('获取控制状态失败', err)
  }
}

async function toggleAuto(loop, enabled) {
  try {
    const res = await api.post('/api/control/auto', { loop, enabled })
    applyControl(res.data.status)
    ElMessage.success(`${loop === 'force' ? '接触力环' : '姿态环'}自动调节${enabled ? '已开启' : '已停止'}`)
  } catch (err) {
    ElMessage.error('切换自动调节失败: ' + (err.response?.data?.error || err.message))
    await refreshControl()
  }
}

async function startTune(loop) {
  tuneLoading.value = true
  try {
    const res = await api.post('/api/control/tune', { loop })
    applyControl(res.data.status)
    ElMessage.info(`阶跃整定已开始 [${loop === 'force' ? '接触力环' : '姿态环'}]，Δu=${res.data.stepDelta}`)
  } catch (err) {
    ElMessage.error('整定启动失败: ' + (err.response?.data?.error || err.message))
  } finally {
    tuneLoading.value = false
  }
}

async function cancelTune() {
  try {
    const res = await api.post('/api/control/tune/cancel')
    applyControl(res.data.status)
    ElMessage.warning('整定已取消')
  } catch (err) {
    ElMessage.error('取消失败: ' + (err.response?.data?.error || err.message))
  }
}

/* ================= 数据入口 ================= */
function handleSensorData(data) {
  updateSensors(data)
  dataSource.value = data.source || ''
  const pkt = data.packet
  packetSeq.value = pkt && pkt.main ? pkt.main.seq : null
  subPacketTag.value = pkt && pkt.sub ? `子包异常 #${pkt.sub.subSeq}` : ''

  if (data.control) {
    control.value = data.control
    pushLoopHistory(data.control)
    nextTick(renderConvChart)
    syncControlToParams()
  }

  if (data.timestamp && data.temperature !== undefined) {
    trendData.value.push({
      timestamp: data.timestamp,
      temperature: data.temperature,
      pressure: data.pressure,
      humidity: data.humidity,
    })
    if (trendData.value.length > 50) trendData.value.shift()
    nextTick(updateTrendChart)
  }
}

/* ================= 模式 ================= */
async function fetchMode() {
  try {
    const res = await api.get('/api/plc/mode')
    mode.value = res.data.mode || 'real'
  } catch { mode.value = 'real' }
}

async function toggleMode() {
  const target = mode.value === 'simulation' ? 'real' : 'simulation'
  modeLoading.value = true
  try {
    const res = await api.post('/api/plc/mode', { mode: target })
    mode.value = res.data.mode
    if (res.data.requested && res.data.mode !== res.data.requested) {
      ElMessage.warning(res.data.message || 'PLC 连接失败，已回退到模拟模式')
    } else {
      ElMessage.success(`已切换到 ${mode.value === 'simulation' ? '模拟' : '真实'}模式`)
    }
    if (mode.value === 'simulation') await fetchPauseStatus()
    else simulationPaused.value = false
  } catch (err) {
    ElMessage.error('切换模式失败: ' + (err.response?.data?.error || err.message))
  } finally {
    modeLoading.value = false
  }
}

async function fetchPauseStatus() {
  if (mode.value !== 'simulation') return
  try {
    const res = await api.get('/api/simulation/pause')
    simulationPaused.value = res.data.paused
  } catch (err) { console.warn('获取暂停状态失败', err) }
}

async function togglePause() {
  pauseLoading.value = true
  try {
    const res = await api.post('/api/simulation/pause')
    simulationPaused.value = res.data.paused
    ElMessage.success(`模拟数据已${simulationPaused.value ? '暂停' : '恢复'}`)
  } catch (err) {
    ElMessage.error('切换暂停状态失败: ' + (err.response?.data?.error || err.message))
  } finally {
    pauseLoading.value = false
  }
}

/* ================= 图表初始化 ================= */
function initCharts() {
  if (convRef.value) {
    if (convChart) convChart.dispose()
    convChart = echarts.init(convRef.value, 'dark')
    renderConvChart()
  }
  if (trendRef.value) {
    if (trendChart) trendChart.dispose()
    trendChart = echarts.init(trendRef.value, 'dark')
    updateTrendChart()
  }
}

/* ================= WebSocket ================= */
function subscribeSensor() {
  if (!socket.connected) return
  socket.emit('subscribe', ['sensor'], (res) => {
    if (!res || !res.ok) console.warn('传感器通道订阅失败:', res)
  })
}
function handleConnect() {
  statusText.value = '已连接'
  statusClass.value = 'normal'
  subscribeSensor()
}
function handleDisconnect() {
  statusText.value = '断开连接'
  statusClass.value = 'disconnected'
}

async function backfillTrend() {
  try {
    const res = await api.get('/api/sensor/recent')
    const list = (res.data && res.data.list) || []
    if (!list.length) return
    trendData.value = list
      .map((s) => ({ timestamp: s.t, temperature: s.temperature, pressure: s.pressure, humidity: s.humidity }))
      .filter((d) => d.temperature !== undefined && d.temperature !== null)
    // 双环收敛曲线同样回填：否则刚打开控制台时曲线是空的，像"没在控制"
    loopHistory.value = list
      .filter((s) => s.contactForce != null && s.height != null)
      .map((s) => ({ t: new Date(s.t).getTime(), force: s.contactForce, posture: s.height }))
    await nextTick()
    updateTrendChart()
    renderConvChart()
  } catch (err) { console.warn('趋势回填失败:', err.message) }
}

/* ================= 生命周期 ================= */
let clockTimer = null
function handleResize() {
  trendChart?.resize()
  convChart?.resize()
}

onMounted(async () => {
  updateTime()
  clockTimer = setInterval(updateTime, 1000)

  socket.on('sensorData', handleSensorData)
  socket.on('connect', handleConnect)
  socket.on('disconnect', handleDisconnect)

  await fetchMode()
  await fetchPauseStatus()
  await refreshControl()
  await nextTick()
  initCharts()
  await backfillTrend()
  if (socket.connected) handleConnect()
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
  socket.off('sensorData', handleSensorData)
  socket.off('connect', handleConnect)
  socket.off('disconnect', handleDisconnect)
  window.removeEventListener('resize', handleResize)
  trendChart?.dispose()
  convChart?.dispose()
})
</script>

<style scoped>
.cockpit {
  width: 100%;
  min-height: 100%;
  box-sizing: border-box;
  padding: 14px 18px 20px;
  color: #e8edf3;
  background: radial-gradient(ellipse at 50% 0%, rgba(0, 198, 255, 0.05) 0%, transparent 60%);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 顶部 */
.ck-head { display: flex; align-items: center; gap: 16px; }
.ck-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ck-h1 { font-size: 20px; font-weight: 600; color: #e0f0ff; }
.ck-sub { font-size: 12px; color: #7a8b9f; }
.ck-status { font-size: 12px; padding: 1px 9px; border-radius: 9px; }
.ck-status.normal { color: #00d68f; background: rgba(0, 214, 143, 0.12); }
.ck-status.connecting { color: #ffaa00; background: rgba(255, 170, 0, 0.12); }
.ck-status.disconnected { color: #ff3d71; background: rgba(255, 61, 113, 0.12); }
.ck-tag { font-size: 11px; color: #8fa6bd; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 0 7px; }
.ck-tag.src-plc { color: #00d68f; border-color: rgba(0,214,143,0.35); }
.ck-tag.src-simulation { color: #ffaa00; border-color: rgba(255,170,0,0.35); }
.ck-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.ck-time { font-size: 12px; color: #8fa6bd; font-variant-numeric: tabular-nums; }

/* KPI */
.ck-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.ck-kpi {
  position: relative;
  background: rgba(255,255,255,0.035);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 14px;
  padding: 12px 14px 12px 16px;
  overflow: hidden;
}
.ck-kpi::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--c); opacity: 0.9;
}
.k-label { font-size: 12px; color: #8fa6bd; letter-spacing: 0.5px; }
.k-value {
  font-size: 34px; font-weight: 700; color: var(--c);
  font-variant-numeric: tabular-nums; line-height: 1.2; margin: 2px 0;
}
.k-value small { font-size: 13px; font-weight: 500; color: #8fa6bd; margin-left: 4px; }
.k-foot { font-size: 11px; color: #7a8b9f; margin-bottom: 7px; }
.k-bar { height: 4px; border-radius: 3px; background: rgba(255,255,255,0.07); overflow: hidden; }
.k-bar > i { display: block; height: 100%; border-radius: 3px; transition: width 0.4s ease; }

/* 双环 + 姿态 */
.ck-main { display: grid; grid-template-columns: 1fr 1fr 0.9fr; gap: 12px; }
.ck-loop, .ck-posture {
  background: rgba(255,255,255,0.032);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 14px;
  padding: 12px 14px;
  min-width: 0;
}
.loop-head { display: flex; align-items: center; margin-bottom: 10px; }
.loop-title { font-size: 14px; font-weight: 600; color: #cfe3f7; }
.loop-head :deep(.el-switch) { margin-left: auto; }
.ck-mini { margin-left: auto; font-size: 11px; color: #7a8b9f; font-weight: 400; }
.recover-tag {
  margin-left: 8px; font-size: 11px; color: #ffaa00;
  background: rgba(255, 170, 0, 0.12);
  border: 1px solid rgba(255, 170, 0, 0.3);
  border-radius: 8px; padding: 0 7px; white-space: nowrap;
}

.loop-nums { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.ln { background: rgba(255,255,255,0.035); border-radius: 9px; padding: 7px 9px; }
.ln-label { display: block; font-size: 11px; color: #8fa6bd; }
.ln-value { font-size: 21px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ln-value small { font-size: 10px; color: #8fa6bd; font-weight: 400; margin-left: 2px; }

.loop-params { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 10px; }
.loop-params label { font-size: 11px; color: #8fa6bd; display: flex; flex-direction: column; gap: 3px; }
.loop-params :deep(.el-input-number) { width: 100%; }
.loop-params :deep(.el-input__wrapper) { background: rgba(255,255,255,0.05); box-shadow: none; }
.loop-params :deep(.el-input__inner) { color: #e8edf3; }

.loop-tune { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.tune-progress { flex: 1; }
.tune-progress :deep(.el-progress__text) { color: #8fa6bd; font-size: 11px !important; }

/* 整定结果条 */
.tune-result {
  margin-top: 9px;
  border-radius: 9px;
  padding: 7px 10px;
  font-size: 12px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  line-height: 1.5;
}
.tune-result.ok { background: rgba(0, 214, 143, 0.09); border: 1px solid rgba(0, 214, 143, 0.28); }
.tune-result.fallback { background: rgba(255, 170, 0, 0.08); border: 1px solid rgba(255, 170, 0, 0.28); }
.tr-title { font-weight: 700; }
.tune-result.ok .tr-title { color: #00d68f; }
.tune-result.fallback .tr-title { color: #ffaa00; }
.tr-item { color: #b9c9da; }
.tr-gains { margin-left: auto; color: #8fa6bd; font-family: ui-monospace, monospace; font-size: 11px; }

/* 姿态图 */
.pose-svg { width: 100%; height: 190px; }
.pose-foot { text-align: center; font-size: 11px; color: #7a8b9f; }

/* 收敛曲线 */
.ck-card {
  background: rgba(255,255,255,0.032);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 14px;
  padding: 12px 14px;
}
.ck-card-head { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; color: #cfe3f7; }
.conv-chart { height: 190px; }

/* 环境 */
.ck-env { display: grid; grid-template-columns: 0.85fr 1.15fr; gap: 12px; }
.env-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.env-item { background: rgba(255,255,255,0.035); border-radius: 10px; padding: 9px 11px; }
.env-item.alarm { outline: 1px solid rgba(255,61,113,0.45); }
.e-label { font-size: 11px; color: #8fa6bd; }
.e-value { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
.e-value small { font-size: 11px; color: #8fa6bd; margin-left: 3px; font-weight: 400; }
.e-bar { height: 4px; border-radius: 3px; background: rgba(255,255,255,0.07); margin-top: 6px; overflow: hidden; }
.e-bar > i { display: block; height: 100%; border-radius: 3px; }
.env-note { margin-top: 10px; font-size: 11px; color: #7a8b9f; line-height: 1.6; }
.trend-chart { height: 170px; }

.ck-foot { font-size: 11px; color: #6f8298; line-height: 1.7; padding: 2px 2px 0; }
</style>
