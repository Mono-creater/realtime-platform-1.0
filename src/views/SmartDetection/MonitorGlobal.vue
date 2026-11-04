<template>
  <div class="monitor-global">
    <!-- ===== 统计卡片行 ===== -->
    <el-row :gutter="20" class="stat-row">
      <el-col :span="6" v-for="(item, idx) in statCards" :key="item.label">
        <el-tooltip :disabled="!item.tip" placement="bottom" effect="dark" :show-after="150">
          <template #content>
            <div style="white-space: pre-line; line-height: 1.7;">{{ item.tip }}</div>
          </template>
          <div class="stat-card" :style="{ '--delay': idx * 0.1 + 's' }">
            <div class="stat-icon"><el-icon :size="36"><component :is="item.icon" /></el-icon></div>
            <div class="stat-content">
              <div class="stat-value" :style="{ color: item.color || '#ffffff' }">{{ item.value }}</div>
              <div class="stat-label">{{ item.label }}</div>
            </div>
            <div class="stat-glow"></div>
          </div>
        </el-tooltip>
      </el-col>
    </el-row>

    <!-- ===== 线网简图（按线路着色，点进到车） ===== -->
    <div class="panel panel-linemap">
      <div class="panel-header"><span class="header-icon"><el-icon><MapLocation /></el-icon></span>线网简图（按线路健康度着色 · 点击下钻到车）</div>
      <div class="linemap">
        <div v-for="ln in lineList" :key="ln.lineId" class="linemap-item" @click="goLine(ln)">
          <span class="lm-line" :style="{ color: healthColorOf(ln.minHealth) }">{{ ln.line }}</span>
          <div class="lm-bar"><div class="lm-fill" :style="{ width: ln.minHealth + '%', background: healthColorOf(ln.minHealth) }"></div></div>
          <span class="lm-health" :style="{ color: healthColorOf(ln.minHealth) }">{{ ln.minHealth }}</span>
          <span class="lm-count">{{ ln.trains.length }} 架受电弓</span>
        </div>
      </div>
    </div>

    <!-- ===== 中间行：实时告警 + 线路状态 ===== -->
    <el-row :gutter="20" class="middle-row">
      <el-col :span="14">
        <div class="panel panel-alarm">
          <div class="panel-header">
            <span class="header-icon"><el-icon><Bell /></el-icon></span>
            实时告警
            <span class="badge">{{ alarmList.length }}</span>
            <!-- 「随机生成」为造数调试入口，正式演示前隐藏。
                 保留开关而非直接删除：需要造数时把 SHOW_RANDOM_ALARM 改为 true 即可，
                 addRandomAlarm() 与后端 POST /api/alert 均已修复可用。 -->
            <el-button
              v-if="SHOW_RANDOM_ALARM"
              size="small"
              type="primary"
              @click="addRandomAlarm"
              style="margin-left: auto;"
            >
              随机生成
            </el-button>
          </div>
          <el-table :data="alarmList" max-height="220" border style="width:100%">
            <el-table-column label="时间" width="160">
              <template #default="{ row }">{{ formatTime(row.timeFull || row.time) }}</template>
            </el-table-column>
            <el-table-column prop="content" label="内容" width="120" />
            <el-table-column prop="code" label="车号" width="140" />
            <el-table-column prop="worker" label="工号" />
            <el-table-column label="操作" width="80" align="center">
              <template #default="{ row }">
                <el-button size="small" type="danger" @click.stop="deleteAlarm(row.id)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="table-footer" v-if="alarmList.length === 0">暂无实时告警</div>
        </div>
      </el-col>
      <el-col :span="10">
        <div class="panel panel-map">
          <div class="panel-header"><span class="header-icon"><el-icon><Location /></el-icon></span>运行状态</div>
          <div class="line-status-content">
            <div class="line-item" v-for="line in statusBars" :key="line.name">
              <span class="line-name">{{ line.name }}</span>
              <div class="line-bar"><div class="line-fill" :style="{ width: line.health + '%', background: line.color }"></div></div>
              <span class="line-health">{{ line.health }}%</span>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- ===== 底部图表行 ===== -->
    <el-row :gutter="20" class="chart-row">
      <el-col :span="12">
        <div class="panel panel-chart">
          <div class="panel-header"><span class="header-icon"><el-icon><TrendCharts /></el-icon></span>告警趋势（近7天）</div>
          <div ref="trendChartRef" class="chart-container"></div>
        </div>
      </el-col>
      <el-col :span="12">
        <div class="panel panel-chart">
          <div class="panel-header"><span class="header-icon"><el-icon><PieChart /></el-icon></span>告警类型分布</div>
          <div v-if="filteredWarningList.length > 0" ref="pieChartRef" class="chart-container"></div>
          <div v-else style="height:200px;display:flex;align-items:center;justify-content:center;color:#b0c4de;font-size:16px;">暂无数据</div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick, computed, watch } from 'vue'
import { Van, Warning, CircleCheck, Monitor, Bell, Location, TrendCharts, PieChart, MapLocation } from '@element-plus/icons-vue'
import { storeToRefs } from 'pinia'
import echarts from '@/utils/echarts'
import axios from 'axios'
import { useRouter } from 'vue-router'
import { useAlarmStore } from '@/stores/alarms'
import { PANTOGRAPH_ALARM_TYPES, computeHealthIndex, healthColor as getHealthColor } from '@/utils/alarm-types'

const router = useRouter()

// ---------- 常量 ----------
// 「随机生成」按钮可见性开关：默认 false（演示态不暴露造数入口）
const SHOW_RANDOM_ALARM = false

// 只保留四种受电弓告警类型（环境预警已过滤）；口径与受电弓详情页共用同一来源
const ALARM_TYPES = PANTOGRAPH_ALARM_TYPES

// 健康度口径（统计窗口、权重、环境类排除、分级边界）统一在 @/utils/alarm-types 中定义，
// 并与后端 health-index.js 保持一致，避免前后端各写一份而逐渐漂移。
const calculateHealth = (list) => computeHealthIndex(list).score
const healthDetailOf = (list) => computeHealthIndex(list)

// ---------- 状态 ----------
// 告警数据统一来自 Pinia store：全站只拉一次 /api/history，后续由 WS 增量（upserts/removed）维护
const store = useAlarmStore()
const { list: fullWarningList, summary: remoteStats } = storeToRefs(store)

const statCards = ref([])
// 过滤后的告警列表（仅四种核心告警）
const filteredWarningList = computed(() => {
  return fullWarningList.value.filter(item => ALARM_TYPES.includes(item.content))
})
// 显示列表（最新10条过滤后的）
const alarmList = computed(() => filteredWarningList.value.slice(0, 10))

// 运行状态条：原为写死的 4 条线路健康度，改为平台真实指标
const statusBars = computed(() => {
  const s = remoteStats.value || {}
  const qualityScore = { GOOD: 100, STALE: 60, BAD: 20 }[s.linkQuality] || 0
  return [
    { name: '链路质量 ' + (s.linkQuality || '--'), health: qualityScore, color: '#2ca7e0' },
    { name: '数据完整率', health: s.dataCompleteness === undefined ? 0 : Math.round(s.dataCompleteness * 100), color: '#1b8edb' },
    { name: '告警处理率', health: s.handleRate === undefined ? 0 : s.handleRate, color: '#0e6fb7' },
    // 明确标注为"告警健康度（30天）"：它按告警加权扣分，与一弓一档的"整弓健康度"不是同一口径
    { name: '告警健康度', health: s.health === undefined ? 0 : s.health, color: '#00c6ff' },
  ]
})

const trendChartRef = ref(null)
const pieChartRef = ref(null)
let trendChart = null
let pieChart = null

// 线网简图数据（来自 /api/v3/lines，按线路健康度着色）
const lineList = ref([])
// 车队整弓健康度（/api/v3/fleet）：与下方"告警健康度"区分口径
const fleet = ref({})
function healthColorOf(score) {
  if (score >= 80) return '#00d68f'
  if (score >= 50) return '#ffaa00'
  return '#ff3d71'
}
function goLine(ln) {
  router.push({ name: 'PantographArchive' })
}

// ---------- 计算函数 ----------
// 告警时间格式化：入参为 ISO 字符串或日期，输出本地时区 "YYYY-MM-DD HH:mm:ss"。
// 无效值统一回退为 '--'，避免表格出现 Invalid Date。
function formatTime(value) {
  if (!value) return '--'
  const d = new Date(value)
  if (isNaN(d.getTime())) return String(value)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function localDayKey(value) {
  const d = value instanceof Date ? value : new Date(value)
  if (isNaN(d.getTime())) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function getTodayAlarms(list) {
  const today = localDayKey(Date.now())
  // 本地时区分日：直接用 UTC 切片会把 0~8 点的告警算到前一天
  return list.filter(item => localDayKey(item.timeFull || item.time) === today).length
}

// 健康度明细（窗口内计入的部件告警、扣分构成），用于卡片悬浮提示
const healthDetail = ref(null)

function healthTip(detail) {
  if (!detail) return ''
  const parts = Object.entries(detail.byType || {})
    .map(([k, v]) => `${k}×${v}`)
    .join('、') || '无'
  const since = detail.windowStart ? `（${detail.windowStart} 起）` : ''
  return `统计窗口：近 ${detail.windowDays} 天${since}\n`
    + `计入部件告警：${detail.counted} 条（${parts}）\n`
    + `加权扣分：${detail.weightSum} × 0.5 = ${detail.penalty} 分\n`
    + `分级：${detail.grade}（边界 85/70/55）\n`
    + '环境与气路类告警（高温/低温/高湿/高压/低压）不参与扣减'
}

// 本地口径的兜底统计（接口不可用时使用真实列表推算，不再退回假数据）
function localStats(list) {
  const since24 = Date.now() - 86400000
  const codes = new Set()
  let handled = 0
  for (const w of list) {
    const t = new Date(w.timeFull || w.time).getTime()
    if (Number.isFinite(t) && t >= since24 && w.code) codes.add(String(w.code))
    if (w.worker && !['PLC_AUTO', 'SIM_AUTO', 'SYSTEM', ''].includes(w.worker)) handled += 1
  }
  return {
    onlineVehicles: codes.size,
    handleRate: list.length ? Math.round((handled / list.length) * 100) : 0,
  }
}

function buildStatCards(list, remote) {
  const detail = healthDetailOf(list)
  healthDetail.value = detail
  const alarmHealth = remote && remote.health !== undefined ? remote.health : detail.score
  // 卡片主指标改用"车队整弓健康度"（3 域加权），避免与健康度评估页的 81.8 对不上；
  // 告警健康度保留在右下角运行状态条，并明确标注统计窗口。
  const teamHealth = fleet.value && fleet.value.avgHealth !== undefined ? fleet.value.avgHealth : null
  const shown = teamHealth !== null ? teamHealth : alarmHealth
  const healthColor = getHealthColor(shown)
  const fallback = localStats(list)
  const teamTip = teamHealth === null
    ? healthTip(detail)
    : `整弓健康度 = 滑板 50% + 气路 25% + 弓网 25%（3 域加权）\n`
      + `在册 ${fleet.value.total} 架，车队平均 ${teamHealth}\n`
      + `分级边界 85 / 70 / 55\n`
      + `另：近 ${detail.windowDays} 天告警加权健康度 ${alarmHealth}%（口径不同，见右下运行状态）`;
  return [
    { label: '在线受电弓', value: remote && remote.onlineVehicles !== undefined ? remote.onlineVehicles : fallback.onlineVehicles, icon: 'Van', color: '#ffffff', tip: '近 24 h 有告警上报的列车去重数（按受电弓档案归集到车号）' },
    { label: '今日告警', value: getTodayAlarms(list), icon: 'Warning', color: '#ffffff', tip: '按本地时区当日 00:00 起统计' },
    { label: '处理率', value: (remote && remote.handleRate !== undefined ? remote.handleRate : fallback.handleRate) + '%', icon: 'CircleCheck', color: '#ffffff', tip: '已登记人工工号的告警占比（PLC_AUTO/SIM_AUTO 不计）' },
    { label: '车队整弓健康度', value: shown + '%', icon: 'Monitor', color: healthColor, tip: teamTip }
  ]
}

// ---------- 统计数据随 store 自动重算 ----------
watch([fullWarningList, remoteStats, fleet], () => {
  statCards.value = buildStatCards(fullWarningList.value, remoteStats.value || {})
}, { immediate: true, deep: true })

// ---------- 随机生成告警（只生成四种核心告警） ----------
async function addRandomAlarm() {
  const types = ALARM_TYPES
  const randomType = types[Math.floor(Math.random() * types.length)]
  const now = new Date()
  const timestamp = now.toISOString()

  const payload = {
    cameraId: 'CAM_SIM',
    timestamp: timestamp,
    alarmType: randomType,
    level: ['一级', '二级', '三级'][Math.floor(Math.random() * 3)],
    value: Math.round((Math.random() * 300 + 50) * 10) / 10,
    code: 'THB' + String(Math.floor(100000 + Math.random() * 900000)),
    worker: 'WX-' + String(Math.floor(1000 + Math.random() * 9000)),
    carNumber: String(Math.floor(1 + Math.random() * 50)),
    line: ['1号线', '2号线', '3号线', '4号线', '5号线'][Math.floor(Math.random() * 5)],
    station: 'A站至B站',
    direction: ['上行', '下行'][Math.floor(Math.random() * 2)],
    location: 'RC' + String(Math.floor(10 + Math.random() * 90)),
    mileage: 'K' + String(Math.floor(10 + Math.random() * 90)) + '+' + String(Math.floor(100 + Math.random() * 900)),
    speed: Math.floor(40 + Math.random() * 60),
    imageUrl: 'http://example.com/sim_' + Date.now() + '.jpg',
    videoUrl: ''
  }

  try {
    const res = await axios.post('/api/alert', payload)
    if (res.data.success) {
      ElMessage.success(`已模拟发送 ${randomType} 告警 (ID: ${res.data.id})`)
    }
  } catch (err) {
    ElMessage.error('发送失败: ' + err.message)
    console.error(err)
  }
}

// ---------- 删除告警 ----------
async function deleteAlarm(id) {
  try {
    await ElMessageBox.confirm('确认删除该告警记录？', '删除确认', {
      confirmButtonText: '确定删除',
      cancelButtonText: '取消',
      type: 'warning'
    })

    const res = await axios.delete(`/api/warning/${id}`)
    if (res.data.success) {
      ElMessage.success('删除成功')
      // 本地立即移除，服务端同时广播增量 removed，其它页面同步更新
      store.removeLocal(id)
      await store.refreshSummary()
      updateTrendChart()
      if (filteredWarningList.value.length > 0) {
        await nextTick()
        await updatePieChart()
      } else if (pieChart) {
        pieChart.clear()
      }
    }
  } catch (err) {
    if (err === 'cancel') return
    ElMessage.error('删除失败: ' + (err.response?.data?.error || err.message))
    console.error(err)
  }
}

// ---------- 数据加载与图表刷新（列表由 store 维护，这里只驱动图表） ----------
async function refreshCharts() {
  await updateTrendChart()
  if (filteredWarningList.value.length > 0) {
    await nextTick()
    await updatePieChart()
  } else if (pieChart) {
    pieChart.clear()
  }
}

async function refreshAll() {
  await store.load({ force: true })
  await store.refreshSummary()
  await refreshCharts()
}

// ========== 饼图只统计受电弓部件告警（弓网 4 类 + 碳滑板 4 类）==========
function getDistributionFromList(list) {
  const counts = {}
  // 初始化全部受电弓部件类型计数为 0
  ALARM_TYPES.forEach(type => { counts[type] = 0 })
  list.forEach(item => {
    if (counts.hasOwnProperty(item.content)) {
      counts[item.content]++
    }
  })
  return ALARM_TYPES.map(name => ({ name, value: counts[name] }))
}
// ============================================================

// ---------- 趋势图 ----------
function calculateTrendData(list) {
  const days = 7
  const result = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now)
    date.setDate(date.getDate() - i)
    const dateStr = date.toISOString().slice(0, 10)
    // 趋势图统计过滤后的核心告警
    const filtered = list.filter(item => ALARM_TYPES.includes(item.content))
    const count = filtered.filter(item => item.time && item.time.startsWith(dateStr)).length
    result.push({ date: dateStr, count })
  }
  return {
    dates: result.map(d => d.date.slice(5)),
    counts: result.map(d => d.count)
  }
}

function buildTrendOption(dates, counts) {
  return {
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(10,30,50,0.9)', borderColor: '#00c6ff', textStyle: { color: '#fff' } },
    grid: { left: '3%', right: '3%', bottom: '3%', top: '8%', containLabel: true },
    xAxis: {
      type: 'category',
      data: dates,
      axisLine: { lineStyle: { color: '#2a4a6a' } },
      axisLabel: { color: '#b0c4de', fontSize: 12 }
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
      axisLabel: { color: '#b0c4de' }
    },
    series: [{
      name: '告警数',
      type: 'line',
      data: counts,
      smooth: true,
      symbol: 'circle',
      symbolSize: 8,
      lineStyle: { color: '#00c6ff', width: 3 },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(0,198,255,0.4)' },
          { offset: 1, color: 'rgba(0,198,255,0.02)' }
        ])
      },
      itemStyle: { color: '#00c6ff' }
    }]
  }
}

// 趋势图：优先使用后端 /api/stats/trend，失败时回退本地计算
async function updateTrendChart() {
  if (!trendChart) return
  let dates, counts
  try {
    const res = await axios.get('/api/stats/trend', { params: { days: 7 } })
    dates = res.data.dates
    counts = res.data.counts
  } catch {
    const local = calculateTrendData(fullWarningList.value)
    dates = local.dates
    counts = local.counts
  }
  trendChart.setOption(buildTrendOption(dates, counts), true)
}

// ---------- 饼图（平滑更新） ----------
async function updatePieChart() {
  if (!pieChartRef.value) return
  if (filteredWarningList.value.length === 0) {
    if (pieChart) pieChart.clear()
    return
  }

  // 优先使用后端 /api/stats/distribution，失败时回退本地计算
  let data
  try {
    const res = await axios.get('/api/stats/distribution')
    const dist = Array.isArray(res.data) ? res.data.filter(d => ALARM_TYPES.includes(d.name)) : []
    data = ALARM_TYPES.map(name => ({ name, value: (dist.find(d => d.name === name) || {}).value || 0 }))
  } catch {
    data = getDistributionFromList(filteredWarningList.value)
  }
  // 无数据时清空图表（模板显示"暂无数据"），不再用固定分布掩盖空库
  const finalData = data.filter(d => d.value > 0)
  if (finalData.length === 0) {
    if (pieChart) pieChart.clear()
    return
  }

  const colors = ['#2ca7e0', '#1b8edb', '#0e6fb7', '#ffc107']
  // 8 类告警时小扇区标签会互相压字：按 item 级 label 关闭 <10% 的标签（图例仍完整）
  const total = finalData.reduce((s, d) => s + d.value, 0) || 1
  const pieData = finalData.map((d) => ({
    ...d,
    label: { show: (d.value / total) * 100 >= 10 },
  }))

  const option = {
    tooltip: { trigger: 'item', backgroundColor: 'rgba(10,30,50,0.9)', borderColor: '#00c6ff', textStyle: { color: '#fff' } },
    legend: {
      orient: 'vertical',
      right: '5%',
      top: 'center',
      textStyle: { color: '#b0c4de', fontSize: 13 },
      itemWidth: 14,
      itemHeight: 14
    },
    series: [{
      type: 'pie',
      radius: ['45%', '72%'],
      avoidLabelOverlap: true,
      label: {
        show: true,
        formatter: '{b}\n{d}%',
        color: '#b0c4de',
        fontSize: 12
      },
      emphasis: {
        scale: false,
        label: { show: true }
      },
      data: pieData,
      color: colors,
      animationDuration: 800,
      animationEasing: 'cubicOut'
    }]
  }

  if (pieChart) {
    pieChart.setOption(option)
  } else {
    pieChart = echarts.init(pieChartRef.value, 'dark')
    pieChart.setOption(option)
  }
  pieChart.resize()
}

// ---------- 初始化趋势图 ----------
async function initTrendChart() {
  if (!trendChartRef.value) return
  if (trendChart) trendChart.dispose()
  trendChart = echarts.init(trendChartRef.value, 'dark')
  updateTrendChart()
}

// ---------- 自适应 ----------
function handleResize() {
  trendChart?.resize()
  pieChart?.resize()
}

// ---------- 生命周期 ----------
let statsTimer = null
let unwatchList = null

onMounted(async () => {
  await initTrendChart()
  // store 内部注册 WS 监听（full/delta 两种帧），并触发首次加载；全站共享同一份列表
  store.bind()
  await refreshAll()
  unwatchList = watch(fullWarningList, () => { refreshCharts() })
  window.addEventListener('resize', handleResize)

  statsTimer = setInterval(() => store.refreshSummary(), 30000)

  // 线网简图：拉取各线路受电弓健康度
  axios.get('/api/v3/lines').then((r) => { lineList.value = r.data.list || [] }).catch(() => {})
  // 车队整弓健康度：与告警健康度分开取数，避免同名不同口径
  axios.get('/api/v3/fleet').then((r) => { fleet.value = r.data.data || {} }).catch(() => {})
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  if (statsTimer) clearInterval(statsTimer)
  if (unwatchList) unwatchList()
  trendChart?.dispose()
  pieChart?.dispose()
})
</script>

<style scoped>
/* ---------- 全局 ---------- */
.monitor-global {
  width: 100%;
  height: 100%;
  padding: 16px 20px;
  box-sizing: border-box;
  overflow-y: auto;
  background: radial-gradient(ellipse at 50% 0%, rgba(0, 198, 255, 0.05) 0%, transparent 70%);
}

/* ---------- 统计卡片 ---------- */
.stat-row {
  margin-bottom: 20px;
}
.stat-card {
  position: relative;
  display: flex;
  align-items: center;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  padding: 18px 24px;
  backdrop-filter: blur(8px);
  transition: all 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  overflow: hidden;
  animation: cardFadeIn 0.6s ease forwards;
  animation-delay: var(--delay, 0s);
  opacity: 0;
}
.stat-card:hover {
  border-color: #00c6ff;
  transform: translateY(-4px);
  box-shadow: 0 12px 40px rgba(0, 198, 255, 0.15);
}
.stat-card .stat-glow {
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle at 30% 30%, rgba(0, 198, 255, 0.05), transparent 70%);
  pointer-events: none;
  transition: 0.5s;
}
.stat-card:hover .stat-glow {
  transform: scale(1.2);
  opacity: 0.5;
}
.stat-icon {
  margin-right: 16px;
  color: #00c6ff;
  filter: drop-shadow(0 0 8px rgba(0, 198, 255, 0.3));
}
.stat-value {
  font-size: 32px;
  font-weight: 700;
  letter-spacing: 0.5px;
}
.stat-label {
  font-size: 14px;
  color: #b0c4de;
  margin-top: 2px;
  letter-spacing: 0.5px;
}
@keyframes cardFadeIn {
  0% { opacity: 0; transform: translateY(20px); }
  100% { opacity: 1; transform: translateY(0); }
}

/* ---------- 面板 ---------- */
.panel {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 16px;
  padding: 18px 20px;
  backdrop-filter: blur(4px);
  transition: border-color 0.3s;
  height: 100%;
}
.panel:hover {
  border-color: rgba(0, 198, 255, 0.2);
}
.panel-header {
  display: flex;
  align-items: center;
  color: #b0c4de;
  font-size: 16px;
  font-weight: 500;
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.header-icon {
  margin-right: 10px;
  color: #00c6ff;
}
.badge {
  background: rgba(0, 198, 255, 0.2);
  color: #00c6ff;
  border-radius: 12px;
  padding: 0 10px;
  font-size: 12px;
  margin-left: 10px;
  line-height: 20px;
}

/* ---------- 线路状态 ---------- */
.line-status-content {
  padding: 4px 0;
}

/* ---------- 线网简图 ---------- */
.panel-linemap {
  /* .panel 默认 height:100%（为 el-col 等高卡片设计），线网简图是独立块，
     继承后会撑满整页，把下面的告警表与图表顶出首屏 —— 这里显式改回内容高度 */
  height: auto;
  margin-bottom: 20px;
}
.linemap {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.linemap-item {
  flex: 1 1 15%;
  min-width: 120px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.2s;
}
.linemap-item:hover { border-color: rgba(0,198,255,0.5); }
.lm-line { font-size: 14px; font-weight: 600; white-space: nowrap; }
.lm-bar { flex: 1; height: 8px; background: rgba(255,255,255,0.08); border-radius: 10px; overflow: hidden; }
.lm-fill { height: 100%; border-radius: 10px; transition: width 0.8s ease; }
.lm-health { font-size: 14px; font-weight: 700; min-width: 28px; }
.lm-count { font-size: 11px; color: #7a8b9f; }
.line-item {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}
.line-name {
  width: 96px;
  color: #b0c4de;
  font-size: 13px;
  flex-shrink: 0;
}
.line-bar {
  flex: 1;
  height: 8px;
  background: rgba(255,255,255,0.08);
  border-radius: 10px;
  margin: 0 12px;
  overflow: hidden;
}
.line-fill {
  height: 100%;
  border-radius: 10px;
  transition: width 1s ease;
  box-shadow: 0 0 12px rgba(0,198,255,0.3);
}
.line-health {
  color: #b0c4de;
  font-size: 13px;
  min-width: 40px;
  text-align: right;
}

/* ---------- 表格 ---------- */
:deep(.el-table) {
  background: transparent !important;
  border-radius: 8px;
  overflow: hidden;
}
:deep(.el-table th.el-table__cell) {
  background: rgba(10, 46, 93, 0.6) !important;
  color: #fff !important;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  font-weight: 500;
}
:deep(.el-table tr) {
  background: rgba(255, 255, 255, 0.04) !important;
}
:deep(.el-table tr:hover) {
  background: rgba(255, 255, 255, 0.04) !important;
  outline: none !important;
}
:deep(.el-table td.el-table__cell) {
  border-bottom: 1px solid rgba(255,255,255,0.04);
  color: #e8edf3;
}
:deep(.el-table__body-wrapper) {
  background: transparent !important;
}
:deep(.el-table__inner-wrapper) {
  border: none;
}
.table-footer {
  text-align: center;
  color: #4a6a8a;
  padding: 20px 0;
  font-size: 14px;
}

/* ---------- 图表 ---------- */
.chart-container {
  width: 100%;
  height: 200px;
  background: transparent !important;
}

/* ---------- 滚动条 ---------- */
.monitor-global::-webkit-scrollbar {
  width: 4px;
}
.monitor-global::-webkit-scrollbar-track {
  background: transparent;
}
.monitor-global::-webkit-scrollbar-thumb {
  background: rgba(0, 198, 255, 0.3);
  border-radius: 10px;
}
.monitor-global::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 198, 255, 0.6);
}
</style>