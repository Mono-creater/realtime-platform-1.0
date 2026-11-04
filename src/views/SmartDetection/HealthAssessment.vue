<template>
  <div class="v3-page">
    <div class="v3-head">
      <span class="v3-h1">健康度评估</span>
      <span class="v3-sub">整弓健康度 = 滑板 50% + 气路 25% + 弓网 25%（加权扣分）；分级边界 85 / 70 / 55</span>
    </div>

    <div class="v3-grid v3-grid-4">
      <div class="v3-kpi" style="--kpi-color:#00c6ff">
        <div class="v3-kpi-label">车队平均健康度</div>
        <div class="v3-kpi-value">{{ avgHealth }}</div>
        <div class="v3-kpi-foot">{{ list.length }} 架受电弓算术平均</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#00d68f">
        <div class="v3-kpi-label">正常</div>
        <div class="v3-kpi-value">{{ grades.正常 }}<small>架</small></div>
        <div class="v3-kpi-foot">≥ 85 分</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#ffaa00">
        <div class="v3-kpi-label">计划检修</div>
        <div class="v3-kpi-value">{{ grades.计划检修 }}<small>架</small></div>
        <div class="v3-kpi-foot">55–70 分</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#ff3d71">
        <div class="v3-kpi-label">立即检修</div>
        <div class="v3-kpi-value">{{ grades.立即检修 }}<small>架</small></div>
        <div class="v3-kpi-foot">&lt; 55 分</div>
      </div>
    </div>

    <div class="v3-row" style="margin-top:14px">
      <div class="v3-card" style="flex:1">
        <div class="v3-card-title">3 域对比 <span class="hint">车队均值 vs 最差一架</span></div>
        <div ref="radarRef" class="chart"></div>
      </div>
      <div class="v3-card" style="flex:1">
        <div class="v3-card-title">分级分布 <span class="hint">按整弓健康度</span></div>
        <div ref="barRef" class="chart"></div>
      </div>
    </div>

    <div class="v3-card" style="margin-top:14px">
      <div class="v3-card-title">单车评估明细 <span class="hint">按整弓健康度升序</span></div>
      <div class="v3-table">
        <el-table :data="sorted" height="300" style="width:100%">
          <el-table-column label="列车 / 弓位" width="150">
            <template #default="{ row }">
              <div>{{ row.line }} {{ row.train }} 车</div>
              <div class="sub">{{ row.position }}</div>
            </template>
          </el-table-column>
          <el-table-column label="整弓" width="90" align="center">
            <template #default="{ row }">
              <span :style="{ color: row.health.color, fontSize: '18px', fontWeight: 700 }">{{ row.health.overall }}</span>
            </template>
          </el-table-column>
          <el-table-column label="滑板域" width="100" align="center">
            <template #default="{ row }"><span :style="{ color: domainColor(row.health.domains.strip) }">{{ row.health.domains.strip }}</span></template>
          </el-table-column>
          <el-table-column label="气路域" width="100" align="center">
            <template #default="{ row }"><span :style="{ color: domainColor(row.health.domains.air) }">{{ row.health.domains.air }}</span></template>
          </el-table-column>
          <el-table-column label="弓网域" width="100" align="center">
            <template #default="{ row }"><span :style="{ color: domainColor(row.health.domains.catenary) }">{{ row.health.domains.catenary }}</span></template>
          </el-table-column>
          <el-table-column label="等级" width="110" align="center">
            <template #default="{ row }">
              <span class="v3-badge" :class="gradeClass(row.health.grade)">{{ row.health.grade }}</span>
            </template>
          </el-table-column>
          <el-table-column label="主要短板" min-width="140">
            <template #default="{ row }">{{ weakDomain(row) }}</template>
          </el-table-column>
          <el-table-column label="扣分来源" min-width="220">
            <template #default="{ row }">{{ weakReason(row) }}</template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import echarts from '@/utils/echarts'
import api from '@/utils/api'

const list = ref([])
const radarRef = ref(null)
const barRef = ref(null)
let radar = null, bar = null

const sorted = computed(() => [...list.value].sort((a, b) => a.health.overall - b.health.overall))

const avgHealth = computed(() => {
  if (!list.value.length) return '—'
  return (list.value.reduce((s, p) => s + p.health.overall, 0) / list.value.length).toFixed(1)
})

const grades = computed(() => {
  const g = { 正常: 0, 关注: 0, 计划检修: 0, 立即检修: 0 }
  for (const p of list.value) g[p.health.grade] = (g[p.health.grade] || 0) + 1
  return g
})

function domainColor(v) {
  if (v >= 85) return '#00d68f'
  if (v >= 70) return '#ffaa00'
  return '#ff3d71'
}
function gradeClass(g) {
  if (g === '正常') return 'ok'
  if (g === '关注') return 'info'
  if (g === '计划检修') return 'warn'
  return 'danger'
}
function weakDomain(row) {
  const d = row.health.domains
  const arr = [['滑板', d.strip], ['气路', d.air], ['弓网', d.catenary]].sort((a, b) => a[1] - b[1])
  return `${arr[0][0]}域（${arr[0][1]} 分）`
}
function weakReason(row) {
  const d = row.health.domains
  if (d.strip <= d.air && d.strip <= d.catenary) {
    return `剩余 ${row.minThicknessMm.toFixed(1)} mm、偏磨 ${row.skewMm} mm、缺陷 ${row.defectCount} 处`
  }
  if (d.air <= d.catenary) {
    return `跟踪误差 ${row.air.trackErrorPct}%、保压压降 ${row.air.leakMpaPer5min} MPa/5min`
  }
  return `接触力 ${row.catenary.contactForceMeanN} N、燃弧率 ${row.catenary.arcRate}%、24h 越限 ${row.catenary.violations24h} 次`
}

function avgDomains() {
  const n = list.value.length || 1
  return list.value.reduce((acc, p) => {
    acc.strip += p.health.domains.strip
    acc.air += p.health.domains.air
    acc.catenary += p.health.domains.catenary
    return acc
  }, { strip: 0, air: 0, catenary: 0 })
}

function renderCharts() {
  if (!radarRef.value || !barRef.value) return
  const avg = avgDomains()
  const n = list.value.length || 1
  const worst = sorted.value[0]

  if (!radar) radar = echarts.init(radarRef.value, 'dark')
  radar.setOption({
    tooltip: { backgroundColor: 'rgba(10,30,50,0.92)', borderColor: '#00c6ff', textStyle: { color: '#fff' } },
    legend: { bottom: 0, textStyle: { color: '#b0c4de' } },
    radar: {
      indicator: [
        { name: '滑板域', max: 100 },
        { name: '气路域', max: 100 },
        { name: '弓网域', max: 100 },
      ],
      radius: '62%',
      axisName: { color: '#b0c4de' },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
      splitArea: { areaStyle: { color: ['rgba(255,255,255,0.02)', 'rgba(255,255,255,0.04)'] } },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
    },
    series: [{
      type: 'radar',
      data: [
        {
          name: '车队均值',
          value: [(avg.strip / n).toFixed(1), (avg.air / n).toFixed(1), (avg.catenary / n).toFixed(1)],
          lineStyle: { color: '#00c6ff', width: 2 },
          areaStyle: { color: 'rgba(0,198,255,0.18)' },
          itemStyle: { color: '#00c6ff' },
        },
        ...(worst ? [{
          name: `最差：${worst.line} ${worst.train}`,
          value: [worst.health.domains.strip, worst.health.domains.air, worst.health.domains.catenary],
          lineStyle: { color: '#ff3d71', width: 2 },
          areaStyle: { color: 'rgba(255,61,113,0.15)' },
          itemStyle: { color: '#ff3d71' },
        }] : []),
      ],
    }],
  }, true)

  if (!bar) bar = echarts.init(barRef.value, 'dark')
  const labels = ['正常', '关注', '计划检修', '立即检修']
  bar.setOption({
    tooltip: { backgroundColor: 'rgba(10,30,50,0.92)', borderColor: '#00c6ff', textStyle: { color: '#fff' } },
    grid: { left: '6%', right: '6%', bottom: '10%', top: '12%', containLabel: true },
    xAxis: { type: 'category', data: labels, axisLabel: { color: '#b0c4de' }, axisLine: { lineStyle: { color: '#2a4a6a' } } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#b0c4de' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } } },
    series: [{
      type: 'bar', barMaxWidth: 46,
      data: labels.map((l, i) => ({
        value: grades.value[l] || 0,
        itemStyle: { color: ['#00d68f', '#00c6ff', '#ffaa00', '#ff3d71'][i], borderRadius: [4, 4, 0, 0] },
      })),
      label: { show: true, position: 'top', color: '#cfe3f7' },
    }],
  }, true)

  radar.resize(); bar.resize()
}

function resize() { radar?.resize(); bar?.resize() }

onMounted(async () => {
  try {
    const { data } = await api.get('/api/v3/pantographs')
    list.value = data.list || []
    await nextTick()
    renderCharts()
  } catch (err) {
    console.warn('健康度评估加载失败', err.message)
  }
  window.addEventListener('resize', resize)
})
onUnmounted(() => {
  window.removeEventListener('resize', resize)
  radar?.dispose(); bar?.dispose()
})
</script>

<style scoped>
.chart { height: 300px; }
.sub { color: #7a8b9f; font-size: 12px; }
</style>
