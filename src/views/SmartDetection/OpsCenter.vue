<!--
  运维中心 —— 论文 §2.1/§2.4/§3 的运行时视图
  数据来源：GET /api/v2/overview（server.js 的实时 pipeline，5 s 轮询 + WS v2Update 即时刷新）
  能力：链路质量（Wilson/质量码/退避）、EWMA 判据（σr/δmin/裕度/σ 标定）、
        自适应变周期（Pn⇄Pa）、工单状态机（指派→开始→完成→复核 / 取消）、告警确认与解除。
-->
<template>
  <div class="ops-center">
    <div class="page-header">
      <div class="title">
        <span class="dot" :class="online ? 'ok' : 'bad'"></span>
        运维中心
        <span class="sub">判据闭环 · 链路质量 · 工单流转</span>
      </div>
      <div class="header-right">
        <span class="stamp" v-if="updatedAt">更新于 {{ updatedAt }}</span>
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <!-- KPI -->
    <el-row :gutter="12" class="kpi-row">
      <el-col :span="4" v-for="k in kpis" :key="k.label">
        <div class="kpi-card">
          <div class="kpi-value" :style="{ color: k.color || '#fff' }">{{ k.value }}</div>
          <div class="kpi-label">{{ k.label }}</div>
          <div class="kpi-tip">{{ k.tip }}</div>
        </div>
      </el-col>
    </el-row>

    <!-- 时钟健康：平台自身与 NTP 的偏差 + 上报端 clientTime 偏差分布 -->
    <div class="panel clock-panel">
      <div class="panel-title">
        时钟健康
        <el-tag size="small" :type="clockTagType" effect="dark">{{ clockLabel }}</el-tag>
        <span class="badge">阈值 ±{{ clock.thresholdMs || 1000 }} ms</span>
        <span class="badge" v-if="clock.stale">结果已过期</span>
      </div>
      <div class="clock-grid">
        <div class="kv"><span>平台时钟偏移</span><b :class="clockOk ? 'ok-text' : 'bad-text'">{{ fmtSigned(clock.offsetMs) }}</b></div>
        <div class="kv"><span>授时来源 / RTT</span><b>{{ clock.source || '--' }} / {{ clock.rttMs === null || clock.rttMs === undefined ? '--' : clock.rttMs + ' ms' }}</b></div>
        <div class="kv"><span>最近校时</span><b>{{ fmtAgo(clock.ageSec) }}</b></div>
        <div class="kv"><span>上报端偏差 p50 / p95</span><b>{{ fmtAbs(clockSkew.p50) }} / {{ fmtAbs(clockSkew.p95) }}</b></div>
        <div class="kv"><span>最大偏差 / 降级条数</span><b>{{ fmtAbs(clockSkew.max) }} / {{ clockSkew.degraded || 0 }}</b></div>
        <div class="kv"><span>窗口样本数</span><b>{{ clockSkew.count || 0 }}</b></div>
      </div>
      <div class="hint">
        平台偏移来自 NTP（不可达时退化为 HTTP Date，精度约 ±0.5 s）；上报端偏差在
        <code>/api/alert</code> 携带 <code>clientTime</code> 时统计，超阈值标记 degraded 但不丢弃数据。
      </div>
    </div>

    <el-row :gutter="12" class="panel-row">
      <!-- 链路质量 -->
      <el-col :span="8">
        <div class="panel">
          <div class="panel-title">
            通信链路质量
            <el-tag size="small" :type="qualityType" effect="dark">{{ link.quality || '--' }}</el-tag>
          </div>
          <div class="kv"><span>收到报文</span><b>{{ link.packets ?? 0 }} 帧</b></div>
          <div class="kv"><span>序号缺口 / 应到</span><b>{{ link.gaps ?? 0 }} / {{ link.expected ?? 0 }}</b></div>
          <div class="kv">
            <span>丢包率（点估计）</span>
            <b>{{ fmtPct(link.lossRate) }}</b>
          </div>
          <div class="kv">
            <span>95% 置信区间（Wilson）</span>
            <b>{{ fmtPct(link.lossCI && link.lossCI.lo) }} ~ {{ fmtPct(link.lossCI && link.lossCI.hi) }}</b>
          </div>
          <div class="kv"><span>回绕次数</span><b>{{ link.wraps ?? 0 }}</b></div>
          <div class="kv"><span>旧固件帧（序号 0，已排除）</span><b>{{ link.legacyFrames ?? 0 }}</b></div>
          <div class="kv"><span>失败次数 / 退避档位</span><b>{{ link.failures ?? 0 }} / {{ link.backoffStep ?? 0 }}</b></div>
          <div class="kv"><span>链路中断累计</span><b>{{ fmtMin(link.downMs) }}</b></div>
          <div class="hint">丢包率点估计为 0 不等于链路无风险：零缺口时 Wilson 上界仍在 3.7% 量级，需结合区间判断。</div>
        </div>
      </el-col>

      <!-- EWMA 判据 -->
      <el-col :span="9">
        <div class="panel">
          <div class="panel-title">
            EWMA 趋势判据（式 5/6/12）
            <el-tag size="small" :type="allResolvable ? 'success' : 'danger'" effect="dark">
              {{ allResolvable ? '判据可分辨' : '判据不可分辨' }}
            </el-tag>
          </div>
          <div class="param-line">
            <span>传感器噪声 σ</span>
            <el-input-number v-model="sigma" :min="0.01" :max="50" :step="0.1" :precision="2" size="small" @change="onSigmaInput" />
            <span class="unit">℃</span>
            <el-button size="small" type="primary" :loading="sigmaSaving" @click="saveSigma">标定</el-button>
          </div>
          <div class="kv"><span>EWMA 系数 λ / 窗口 W</span><b>{{ ewma.lambda }} / {{ ewma.windowMin }} min</b></div>
          <div class="kv"><span>σ_roc（式6）</span><b>{{ fixed(ewma.sigmaRoc, 4) }} ℃/min</b></div>
          <div class="kv"><span>δ_min = 3σ_roc（式12）</span><b>{{ fixed(ewma.deltaMin, 4) }}</b></div>
          <el-table :data="ewmaRows" size="small" class="mini-table">
            <el-table-column prop="sig" label="通道" width="80" />
            <el-table-column prop="rw" label="阈值 rw" width="90" />
            <el-table-column prop="margin" label="裕度" width="90" />
            <el-table-column prop="sigmaMax" label="σ 上限" width="90" />
            <el-table-column label="判定" width="90">
              <template #default="{ row }">
                <span :class="row.ok ? 'ok-text' : 'bad-text'">{{ row.ok ? '可分辨' : '不可分辨' }}</span>
              </template>
            </el-table-column>
          </el-table>
          <div class="hint">阈值通道与变化率通道共用同一 EWMA 序列；窗口按时间裁剪，与轮询周期解耦。</div>
        </div>
      </el-col>

      <!-- 自适应变周期 + RUL -->
      <el-col :span="7">
        <div class="panel">
          <div class="panel-title">
            自适应变周期（式 10）
            <el-tag size="small" :type="adaptive.state === 'SUSPECT' ? 'warning' : 'info'" effect="dark">
              {{ adaptive.state }}
            </el-tag>
          </div>
          <div class="param-line">
            <span>Pn</span>
            <el-input-number v-model="pnSec" :min="1" :max="300" :step="1" size="small" />
            <span>Pa</span>
            <el-input-number v-model="paSec" :min="1" :max="60" :step="1" size="small" />
            <el-button size="small" type="primary" :loading="periodSaving" @click="savePeriod">应用</el-button>
          </div>
          <div class="kv"><span>当前上报周期</span><b>{{ adaptive.periodSec }} s</b></div>
          <div class="kv"><span>状态切换次数</span><b>{{ adaptive.switches ?? 0 }}</b></div>
          <div class="kv"><span>累计采样</span><b>{{ overview.ingested ?? 0 }}</b></div>
          <div class="kv"><span>运行时长</span><b>{{ fmtSec(overview.uptimeSec) }}</b></div>
          <div class="divider"></div>
          <div class="panel-subtitle">剩余寿命 RUL（式 8）</div>
          <template v-if="rul && rul.rul !== null && rul.rul !== undefined">
            <div class="kv"><span>退化速率 β</span><b>{{ fixed(rul.beta, 4) }} ℃/min</b></div>
            <div class="kv"><span>RUL 点估计</span><b class="accent">{{ fixed(rul.rul, 1) }} min</b></div>
            <div class="kv"><span>95% 区间</span><b>{{ fixed(rul.rulLo, 1) }} ~ {{ fixed(rul.rulHi, 1) }} min</b></div>
            <div class="kv"><span>拟合优度 R² / 样本</span><b>{{ fixed(rul.r2, 3) }} / {{ rul.n }}</b></div>
          </template>
          <div v-else class="hint">{{ (rul && rul.note) || '样本不足或退化趋势未达可辨识下限，暂不外推 RUL' }}</div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="12" class="panel-row">
      <!-- 工单 -->
      <el-col :span="14">
        <div class="panel">
          <div class="panel-title">
            工单闭环（表 5）
            <span class="badge">未闭环 {{ openOrders }} / 共 {{ orders.length }}</span>
            <span class="badge" v-if="mttr">MTTR {{ mttr }} min</span>
            <a class="export-link" href="/api/v2/orders/export?format=csv" title="导出全部工单（CSV）">导出 CSV</a>
          </div>
          <el-table :data="orders" size="small" max-height="300" empty-text="暂无工单（major/critical 告警会自动建单）">
            <el-table-column prop="id" label="工单号" width="92" />
            <el-table-column prop="deviceId" label="设备" width="88" />
            <el-table-column label="等级" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="levelType(row.level)" effect="dark">{{ row.level }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="description" label="描述" min-width="180" show-overflow-tooltip />
            <el-table-column label="状态" width="96">
              <template #default="{ row }">
                <el-tag size="small" :type="statusType(row.status)" effect="plain">{{ statusLabel(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="assignee" label="处理人" width="84" />
            <el-table-column label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.status === 'new'" size="small" link type="primary" @click="act(row, 'assign')">指派</el-button>
                <el-button v-else-if="row.status === 'assigned'" size="small" link type="primary" @click="act(row, 'start')">开始</el-button>
                <el-button v-else-if="row.status === 'in_progress'" size="small" link type="success" @click="act(row, 'complete')">完成</el-button>
                <el-button v-else-if="row.status === 'completed'" size="small" link type="success" @click="act(row, 'verify')">复核</el-button>
                <el-button
                  v-if="['new', 'assigned', 'in_progress'].includes(row.status)"
                  size="small" link type="danger" @click="act(row, 'cancel')"
                >取消</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-col>

      <!-- 告警 -->
      <el-col :span="10">
        <div class="panel">
          <div class="panel-title">
            EWMA 告警（引擎实时）
            <span class="badge">共 {{ alarmStats.total || 0 }} 条</span>
            <span class="badge">变化率通道 {{ alarmStats.rocAlarms || 0 }}</span>
            <span class="badge">抑制 {{ alarmStats.suppressed || 0 }}</span>
          </div>
          <el-table :data="recentAlarms" size="small" max-height="300" empty-text="暂无 EWMA 告警">
            <el-table-column label="时间" width="88">
              <template #default="{ row }">{{ fmtClock(row.t) }}</template>
            </el-table-column>
            <el-table-column label="通道" width="66">
              <template #default="{ row }">{{ sigLabel(row.signal) }}</template>
            </el-table-column>
            <el-table-column label="等级" width="82">
              <template #default="{ row }">
                <el-tag size="small" :type="levelType(row.level)" effect="dark">{{ row.level }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="value" label="值" width="66" />
            <el-table-column label="来源" width="80">
              <template #default="{ row }">{{ row.source === 'roc' ? '变化率' : '阈值' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="110" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.status === 'active'" size="small" link type="primary" @click="ackAlarm(row)">确认</el-button>
                <el-button v-else size="small" link type="success" @click="clearAlarm(row)">解除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="hint">
            变化率通道的告警通常早于阈值通道出现 —— 这是 EWMA 趋势检测相对纯阈值判据的提前量。
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import socket from '@/socket'

const overview = ref({})
const loading = ref(false)
const updatedAt = ref('')
const sigma = ref(1.0)
const pnSec = ref(10)
const paSec = ref(1)
const sigmaSaving = ref(false)
const periodSaving = ref(false)
let timer = null
// 用户手动改过 σ 后，轮询不再用服务端值覆盖输入框
let sigmaTouched = false

const link = computed(() => overview.value.link || {})
const alarms = computed(() => overview.value.alarms || {})
const alarmStats = computed(() => alarms.value || {})
const recentAlarms = computed(() => alarms.value.recent || [])
const orders = computed(() => (overview.value.orders && overview.value.orders.list) || [])
const mttr = computed(() => overview.value.mttrMin || (overview.value.orders && overview.value.orders.mttr))
const ewma = computed(() => overview.value.ewma || {})
const adaptive = computed(() => overview.value.adaptive || {})
const rul = computed(() => overview.value.rul)

// 时钟健康
const clock = computed(() => overview.value.clock || {})
const clockSkew = computed(() => overview.value.clockSkew || {})
const clockOk = computed(() => clock.value.ok === true)
const clockLabel = computed(() => {
  const c = clock.value
  if (c.source === 'disabled') return '已关闭'
  if (c.ok === null || c.ok === undefined) return c.error ? '不可用' : '待检测'
  return c.ok ? '正常' : '疑似漂移'
})
const clockTagType = computed(() => {
  if (clock.value.ok === true) return 'success'
  if (clock.value.ok === null || clock.value.ok === undefined) return 'info'
  return 'danger'
})

const online = computed(() => link.value.quality === 'GOOD')

const openOrders = computed(() =>
  orders.value.filter(o => !['verified', 'cancelled'].includes(o.status)).length
)

const allResolvable = computed(() => {
  const r = ewma.value.resolvable || {}
  return Object.keys(r).length > 0 && Object.values(r).every(Boolean)
})

const kpis = computed(() => {
  const av = overview.value.availability
  const dc = overview.value.dataCompleteness
  return [
    { label: '可用率', value: av === undefined ? '--' : (av * 100).toFixed(2) + '%', tip: '1 − 链路中断累计/运行时长' },
    { label: '数据完整率', value: dc === undefined ? '--' : (dc * 100).toFixed(2) + '%', tip: '有效样本/应到包数（序号缺口口径）' },
    { label: '丢包率', value: fmtPct(link.value.lossRate), tip: '序号缺口/应到包数' },
    { label: 'EWMA 告警', value: alarmStats.value.total || 0, tip: '变化率通道 ' + (alarmStats.value.rocAlarms || 0) + ' 条' },
    { label: '未闭环工单', value: openOrders.value, tip: 'new / assigned / in_progress / completed', color: openOrders.value > 0 ? '#ffaa00' : '#fff' },
    { label: 'MTTR', value: mttr.value === null || mttr.value === undefined ? '--' : mttr.value + ' min', tip: '平均修复时间（式 9）' },
  ]
})

const ewmaRows = computed(() => {
  const checks = ewma.value.resolvable || {}
  const margin = ewma.value.margin || {}
  const bound = ewma.value.noiseBoundary || {}
  const cfg = { temperature: 2, pressure: 80, humidity: 5 }
  return Object.keys(checks).map(sig => ({
    sig: sigLabel(sig),
    rw: cfg[sig],
    margin: margin[sig] === undefined ? '--' : margin[sig].toFixed(2) + 'σr',
    sigmaMax: bound[sig] === undefined ? '--' : bound[sig].toFixed(2),
    ok: checks[sig],
  }))
})

function sigLabel(s) {
  return { temperature: '温度', pressure: '压力', humidity: '湿度' }[s] || s
}
function levelType(l) {
  return { warning: 'warning', major: 'danger', critical: 'danger' }[l] || 'info'
}
function statusType(s) {
  return { new: 'info', assigned: 'warning', in_progress: 'primary', completed: 'success', verified: 'success', cancelled: 'info' }[s] || 'info'
}
function statusLabel(s) {
  return { new: '新建', assigned: '已指派', in_progress: '处理中', completed: '已完成', verified: '已复核', cancelled: '已取消' }[s] || s
}
function fixed(v, n) {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? '--' : Number(v).toFixed(n)
}
function fmtPct(v) {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? '--' : (Number(v) * 100).toFixed(2) + '%'
}
function fmtMin(ms) {
  if (!ms) return '0 min'
  return (ms / 60000).toFixed(1) + ' min'
}
function fmtSec(s) {
  if (s === undefined || s === null) return '--'
  if (s < 60) return s + ' s'
  if (s < 3600) return Math.floor(s / 60) + ' min ' + (s % 60) + ' s'
  return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min'
}
function fmtClock(t) {
  const d = new Date(t)
  if (isNaN(d.getTime())) return '--'
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 带符号毫秒（平台时钟偏移可能为负）
function fmtSigned(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '--'
  const n = Number(v)
  return `${n > 0 ? '+' : ''}${n} ms`
}
// 偏差绝对值（p50/p95/max）
function fmtAbs(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '--'
  return `${Math.round(Number(v))} ms`
}
function fmtAgo(sec) {
  if (sec === null || sec === undefined) return '--'
  if (sec < 60) return `${sec} s 前`
  if (sec < 3600) return `${Math.floor(sec / 60)} min 前`
  return `${Math.floor(sec / 3600)} h 前`
}

async function load() {
  loading.value = true
  try {
    const res = await axios.get('/api/v2/overview')
    overview.value = res.data || {}
    if (!sigmaTouched) sigma.value = overview.value.sigma ?? 1.0
    pnSec.value = overview.value.adaptive ? overview.value.adaptive.cfg.pnSec : pnSec.value
    paSec.value = overview.value.adaptive ? overview.value.adaptive.cfg.paSec : paSec.value
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    updatedAt.value = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  } catch (err) {
    console.warn('运维中心数据加载失败:', err.message)
  } finally {
    loading.value = false
  }
}

function onSigmaInput() { sigmaTouched = true }

async function saveSigma() {
  sigmaSaving.value = true
  try {
    const res = await axios.post('/api/v2/ewma/sigma', { sigma: sigma.value })
    if (res.data && res.data.analytics) overview.value = { ...overview.value, ewma: res.data.analytics }
    sigmaTouched = false
    ElMessage.success(`噪声 σ 已标定为 ${sigma.value}，判据已按式(12) 重新校核`)
    await load()
  } catch (err) {
    ElMessage.error('标定失败：' + (err.response?.data?.error || err.message))
  } finally {
    sigmaSaving.value = false
  }
}

async function savePeriod() {
  periodSaving.value = true
  try {
    await axios.post('/api/v2/adaptive/period', { pnSec: pnSec.value, paSec: paSec.value })
    ElMessage.success(`上报周期已更新：Pn=${pnSec.value}s / Pa=${paSec.value}s`)
    await load()
  } catch (err) {
    ElMessage.error('更新失败：' + (err.response?.data?.error || err.message))
  } finally {
    periodSaving.value = false
  }
}

async function act(row, action) {
  let worker = row.assignee || ''
  let note = ''
  try {
    if (action === 'assign') {
      const r = await ElMessageBox.prompt('指派给（工号）', '指派工单', { inputValue: 'WX-1001' })
      worker = r.value
    } else if (action === 'complete') {
      const r = await ElMessageBox.prompt('处理说明（可空）', '完成工单', { inputValue: '已更换碳滑板并复测' })
      note = r.value || ''
    } else if (action === 'verify') {
      const r = await ElMessageBox.prompt('复核结论（可空）', '复核工单', { inputValue: '复测正常' })
      note = r.value || ''
    } else if (action === 'cancel') {
      const r = await ElMessageBox.prompt('取消原因（必填）', '取消工单', { inputValue: '复核确认误报' })
      note = r.value || ''
    } else {
      await ElMessageBox.confirm('确认开始处理该工单？', '开始工单', { type: 'info' })
    }
  } catch {
    return   // 用户取消
  }
  try {
    const res = await axios.post(`/api/v2/orders/${row.id}/${action}`, { worker, note })
    if (res.data && res.data.ok === false) {
      ElMessage.warning(res.data.error)
    } else {
      ElMessage.success('工单已更新')
    }
    await load()
  } catch (err) {
    ElMessage.error('操作失败：' + (err.response?.data?.error || err.message))
  }
}

async function ackAlarm(row) {
  try {
    const r = await ElMessageBox.prompt('确认人工号', '确认告警', { inputValue: 'WX-1001' })
    await axios.post(`/api/v2/alarms/${row.id}/ack`, { worker: r.value })
    ElMessage.success('告警已确认')
    await load()
  } catch (err) {
    if (err === 'cancel') return
    ElMessage.error('确认失败：' + (err.response?.data?.error || err.message))
  }
}

async function clearAlarm(row) {
  try {
    await ElMessageBox.confirm('解除后该告警进入 cleared 状态，确认？', '解除告警', { type: 'warning' })
    await axios.post(`/api/v2/alarms/${row.id}/clear`, {})
    ElMessage.success('告警已解除')
    await load()
  } catch (err) {
    if (err === 'cancel') return
    ElMessage.error('解除失败：' + (err.response?.data?.error || err.message))
  }
}

function refreshSoon() {
  clearTimeout(refreshSoon._t)
  refreshSoon._t = setTimeout(load, 800)
}

onMounted(() => {
  load()
  timer = setInterval(load, 5000)
  socket.on('v2Update', refreshSoon)
  socket.on('connect', load)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  clearTimeout(refreshSoon._t)
  socket.off('v2Update', refreshSoon)
  socket.off('connect', load)
})
</script>

<style scoped>
.ops-center {
  width: 100%;
  min-height: 100%;
  padding: 16px;
  box-sizing: border-box;
  color: #fff;
  background: radial-gradient(ellipse at 50% 0%, rgba(0, 198, 255, 0.06) 0%, transparent 70%);
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}
.page-header .title {
  font-size: 20px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 10px;
}
.page-header .sub {
  font-size: 12px;
  font-weight: 400;
  color: #7a8b9f;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
}
.dot.ok { background: #00d68f; box-shadow: 0 0 8px #00d68f; }
.dot.bad { background: #ff3d71; box-shadow: 0 0 8px #ff3d71; }
.header-right { display: flex; align-items: center; gap: 10px; }
.stamp { font-size: 12px; color: #7a8b9f; }

.kpi-row { margin-bottom: 12px; }
.clock-panel {
  margin-bottom: 12px;
  padding: 10px 14px;
}
.clock-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  column-gap: 28px;
}
.clock-panel .kv { padding: 4px 0; }
.clock-panel code {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  padding: 0 4px;
  font-size: 11px;
}
.kpi-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  padding: 12px 14px;
  height: 92px;
  box-sizing: border-box;
}
.kpi-value { font-size: 24px; font-weight: 600; line-height: 1.2; }
.kpi-label { font-size: 13px; color: #b0c4de; margin-top: 4px; }
.kpi-tip { font-size: 11px; color: #6b7d92; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.panel-row { margin-bottom: 12px; }
.panel {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  padding: 12px 14px;
  height: 100%;
  box-sizing: border-box;
}
.panel-title {
  font-size: 15px;
  font-weight: 600;
  color: #cfe3f7;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.panel-subtitle { font-size: 13px; color: #9fb6cc; margin: 6px 0; }
.badge {
  font-size: 11px;
  font-weight: 400;
  color: #00c6ff;
  background: rgba(0, 198, 255, 0.12);
  border-radius: 9px;
  padding: 1px 8px;
}
.export-link {
  margin-left: auto;
  font-size: 11px;
  color: #00c6ff;
  text-decoration: none;
  border-bottom: 1px dashed rgba(0, 198, 255, 0.45);
}
.export-link:hover { color: #7fe3ff; }
.kv {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #9fb6cc;
  padding: 3px 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.05);
}
.kv b { color: #e6f1ff; font-weight: 500; }
.kv b.accent { color: #00d68f; }
.param-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
  color: #9fb6cc;
}
.param-line .unit { color: #6b7d92; }
.mini-table { margin: 8px 0 4px; background: transparent; }
.divider { height: 1px; background: rgba(255, 255, 255, 0.07); margin: 10px 0; }
.hint { font-size: 11px; color: #6b7d92; line-height: 1.6; margin-top: 8px; }
.ok-text { color: #00d68f; }
.bad-text { color: #ff3d71; }

:deep(.el-table) {
  background: transparent;
  --el-table-border-color: rgba(255, 255, 255, 0.06);
  --el-table-header-bg-color: rgba(0, 198, 255, 0.08);
  --el-table-tr-bg-color: transparent;
  --el-table-row-hover-bg-color: rgba(0, 198, 255, 0.08);
  color: #dce9f7;
  font-size: 12px;
}
:deep(.el-table th.el-table__cell) { color: #9fb6cc; font-weight: 500; background: rgba(0, 198, 255, 0.06); }
:deep(.el-table td.el-table__cell),
:deep(.el-table th.el-table__cell) { border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
:deep(.el-table__empty-text) { color: #6b7d92; }
:deep(.el-input-number) { width: 92px; }
:deep(.el-input__wrapper) { background: rgba(255, 255, 255, 0.06); box-shadow: none; }
:deep(.el-input__inner) { color: #e6f1ff; }
</style>
