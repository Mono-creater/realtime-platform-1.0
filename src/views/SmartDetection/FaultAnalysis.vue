<template>
  <div class="v3-page">
    <div class="v3-head">
      <span class="v3-h1">故障分析</span>
      <span class="v3-sub">按告警类型做 Pareto 与趋势分析，区分"弓网关系"与"碳滑板自身"，避免只看总量</span>
    </div>

    <div class="v3-grid v3-grid-4">
      <div class="v3-kpi" style="--kpi-color:#00c6ff">
        <div class="v3-kpi-label">告警总数</div>
        <div class="v3-kpi-value">{{ list.length }}<small>条</small></div>
        <div class="v3-kpi-foot">当前列表（最多 500 条）</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#ff3d71">
        <div class="v3-kpi-label">碳滑板自身占比</div>
        <div class="v3-kpi-value">{{ carbonRatio }}<small>%</small></div>
        <div class="v3-kpi-foot">磨耗 / 偏磨 / 裂纹 / 电弧</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#ffaa00">
        <div class="v3-kpi-label">近 7 天</div>
        <div class="v3-kpi-value">{{ last7 }}<small>条</small></div>
        <div class="v3-kpi-foot">用于判断是否在恶化</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#7be5e5">
        <div class="v3-kpi-label">日均</div>
        <div class="v3-kpi-value">{{ perDay }}<small>条/天</small></div>
        <div class="v3-kpi-foot">按最近 30 天计</div>
      </div>
    </div>

    <div class="v3-row" style="margin-top:14px">
      <div class="v3-card" style="flex:1.5">
        <div class="v3-card-title">类型 Pareto <span class="hint">柱=条数，折线=累计占比</span></div>
        <div ref="paretoRef" class="chart"></div>
      </div>
      <div class="v3-card" style="flex:1">
        <div class="v3-card-title">三类构成 <span class="hint">弓网 / 碳滑板 / 环境</span></div>
        <div ref="donutRef" class="chart"></div>
      </div>
    </div>

    <div class="v3-row" style="margin-top:14px">
      <div class="v3-card" style="flex:1">
        <div class="v3-card-title">近 30 天趋势</div>
        <div ref="trendRef" class="trend"></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { storeToRefs } from 'pinia'
import echarts from '@/utils/echarts'
import { useAlarmStore } from '@/stores/alarms'
import {
  CATENARY_ALARM_TYPES, CARBON_STRIP_ALARM_TYPES, ENV_ALARM_TYPES,
} from '@/utils/alarm-types'

const store = useAlarmStore()
const { list } = storeToRefs(store)

const paretoRef = ref(null)
const donutRef = ref(null)
const trendRef = ref(null)
let pareto = null, donut = null, trend = null

const cardStyle = {
  tooltip: { backgroundColor: 'rgba(10,30,50,0.92)', borderColor: '#00c6ff', textStyle: { color: '#fff' } },
}

const carbonRatio = computed(() => {
  if (!list.value.length) return '—'
  const n = list.value.filter((w) => CARBON_STRIP_ALARM_TYPES.includes(w.content)).length
  return Math.round((n / list.value.length) * 1000) / 10
})

function timeOf(w) {
  const t = new Date(w.timeFull || w.time).getTime()
  return Number.isFinite(t) ? t : 0
}

const last7 = computed(() => {
  const cut = Date.now() - 7 * 86400000
  return list.value.filter((w) => timeOf(w) >= cut).length
})

const perDay = computed(() => {
  const cut = Date.now() - 30 * 86400000
  const n = list.value.filter((w) => timeOf(w) >= cut).length
  return Math.round((n / 30) * 10) / 10
})

function categoryOf(content) {
  if (CARBON_STRIP_ALARM_TYPES.includes(content)) return '碳滑板自身'
  if (CATENARY_ALARM_TYPES.includes(content)) return '弓网关系'
  if (ENV_ALARM_TYPES.includes(content)) return '环境/气路'
  return '其他'
}

function renderAll() {
  if (!paretoRef.value || !donutRef.value || !trendRef.value) return

  // ---- Pareto：按条数降序 ----
  const counts = {}
  for (const w of list.value) counts[w.content] = (counts[w.content] || 0) + 1
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1
  let acc = 0
  const cum = entries.map(([, v]) => {
    acc += v
    return +((acc / total) * 100).toFixed(1)
  })

  if (!pareto) pareto = echarts.init(paretoRef.value, 'dark')
  pareto.setOption({
    ...cardStyle,
    grid: { left: '4%', right: '6%', bottom: '12%', top: '12%', containLabel: true },
    xAxis: {
      type: 'category',
      data: entries.map(([k]) => k),
      axisLabel: { color: '#b0c4de', interval: 0, rotate: 26, fontSize: 11 },
      axisLine: { lineStyle: { color: '#2a4a6a' } },
    },
    yAxis: [
      { type: 'value', name: '条数', axisLabel: { color: '#b0c4de' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } } },
      { type: 'value', name: '累计%', max: 100, axisLabel: { color: '#b0c4de' }, splitLine: { show: false } },
    ],
    series: [
      {
        type: 'bar', data: entries.map(([, v]) => v), barMaxWidth: 34,
        itemStyle: {
          borderRadius: [4, 4, 0, 0],
          color: (p) => (CARBON_STRIP_ALARM_TYPES.includes(entries[p.dataIndex][0]) ? '#ff3d71' : '#00c6ff'),
        },
      },
      {
        type: 'line', yAxisIndex: 1, data: cum, smooth: false,
        symbol: 'circle', symbolSize: 6,
        lineStyle: { color: '#ffaa00', width: 2 }, itemStyle: { color: '#ffaa00' },
      },
    ],
  }, true)

  // ---- 三类构成 ----
  const catCounts = {}
  for (const w of list.value) {
    const c = categoryOf(w.content)
    catCounts[c] = (catCounts[c] || 0) + 1
  }
  if (!donut) donut = echarts.init(donutRef.value, 'dark')
  donut.setOption({
    ...cardStyle,
    tooltip: { ...cardStyle.tooltip, trigger: 'item', formatter: '{b}：{c} 条（{d}%）' },
    legend: { bottom: 0, textStyle: { color: '#b0c4de' } },
    color: ['#00c6ff', '#ff3d71', '#7a8b9f'],
    series: [{
      type: 'pie', radius: ['46%', '68%'], center: ['50%', '44%'],
      label: { color: '#cfe3f7', formatter: '{b}\n{d}%' },
      data: Object.entries(catCounts).map(([name, value]) => ({ name, value })),
    }],
  }, true)

  // ---- 30 天趋势 ----
  const days = []
  const vals = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    days.push(key.slice(5))
    vals.push(list.value.filter((w) => String(w.timeFull || w.time || '').slice(0, 10) === key).length)
  }
  if (!trend) trend = echarts.init(trendRef.value, 'dark')
  trend.setOption({
    ...cardStyle,
    grid: { left: '3%', right: '3%', bottom: '8%', top: '12%', containLabel: true },
    xAxis: { type: 'category', data: days, axisLabel: { color: '#b0c4de', fontSize: 10 }, axisLine: { lineStyle: { color: '#2a4a6a' } } },
    yAxis: { type: 'value', axisLabel: { color: '#b0c4de' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } } },
    series: [{
      type: 'line', data: vals, smooth: true, symbol: 'none',
      lineStyle: { color: '#00c6ff', width: 2 },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(0,198,255,0.35)' },
          { offset: 1, color: 'rgba(0,198,255,0.02)' },
        ]),
      },
    }],
  }, true)
}

function resize() {
  pareto?.resize(); donut?.resize(); trend?.resize()
}

onMounted(async () => {
  store.bind()
  await nextTick()
  renderAll()
  window.addEventListener('resize', resize)
})
onUnmounted(() => {
  window.removeEventListener('resize', resize)
  pareto?.dispose(); donut?.dispose(); trend?.dispose()
})
watch(list, () => nextTick(renderAll), { deep: false })
</script>

<style scoped>
.chart { height: 300px; }
.trend { height: 190px; }
</style>
