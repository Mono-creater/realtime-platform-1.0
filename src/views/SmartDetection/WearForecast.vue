<template>
  <div class="v3-page">
    <div class="v3-head">
      <span class="v3-h1">磨耗预测</span>
      <span class="v3-sub">用磨耗历史做最小二乘线性外推：剩余寿命 =（当前厚度 − 到限 10 mm）÷ 磨耗速率</span>
    </div>

    <div class="v3-grid v3-grid-4">
      <div class="v3-kpi" style="--kpi-color:#00c6ff">
        <div class="v3-kpi-label">车队平均磨耗速率</div>
        <div class="v3-kpi-value">{{ avgRate }}<small>mm/万km</small></div>
        <div class="v3-kpi-foot">正常参考 5–7，6 号线标定约 13</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#ff3d71">
        <div class="v3-kpi-label">最快磨耗</div>
        <div class="v3-kpi-value">{{ fastest.rate ?? '—' }}<small>mm/万km</small></div>
        <div class="v3-kpi-foot">{{ fastest.train ? fastest.line + ' ' + fastest.train + ' 车' : '—' }}</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#ffaa00">
        <div class="v3-kpi-label">30 天内到限</div>
        <div class="v3-kpi-value">{{ due30 }}<small>架</small></div>
        <div class="v3-kpi-foot">按当前磨耗速率折算</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#00d68f">
        <div class="v3-kpi-label">最薄剩余厚度</div>
        <div class="v3-kpi-value">{{ minThickness }}<small>mm</small></div>
        <div class="v3-kpi-foot">到限 10 mm</div>
      </div>
    </div>

    <div class="v3-row" style="margin-top:14px">
      <div class="v3-card" style="flex:1.35">
        <div class="v3-card-title">磨耗速率 × 剩余厚度 <span class="hint">越靠左上越紧急（磨得快、剩得少）</span></div>
        <div ref="scatterRef" class="chart"></div>
      </div>
      <div class="v3-card" style="flex:1">
        <div class="v3-card-title">预测口径</div>
        <div class="method">
          <p><b>磨耗速率</b>：取最近 6 个厚度采样点做最小二乘拟合，斜率换算为 mm/万km。</p>
          <p><b>剩余寿命</b>：剩余厚度余量 ÷ 磨耗速率，单位万km。</p>
          <p><b>到限天数</b>：剩余寿命 ÷ 本车日均里程（累计里程 ÷ 投运天数）。</p>
          <p class="tip">这是"趋势外推"，不是物理模型：若线路条件、编组或弓头几何变化，需重新标定。</p>
        </div>
      </div>
    </div>

    <div class="v3-card" style="margin-top:14px">
      <div class="v3-card-title">单车预测明细 <span class="hint">按剩余寿命升序</span></div>
      <div class="v3-table">
        <el-table :data="sorted" height="300" style="width:100%">
          <el-table-column label="列车 / 弓位" width="150">
            <template #default="{ row }">
              <div>{{ row.line }} {{ row.train }} 车</div>
              <div class="sub">{{ row.position }}</div>
            </template>
          </el-table-column>
          <el-table-column label="当前厚度" width="110" align="center">
            <template #default="{ row }">{{ row.minThicknessMm.toFixed(1) }} mm</template>
          </el-table-column>
          <el-table-column label="磨耗速率" width="146" align="center">
            <template #default="{ row }">{{ row.wear?.wearRateMmPerWanKm ?? '—' }} mm/万km</template>
          </el-table-column>
          <el-table-column label="剩余寿命" width="110" align="center">
            <template #default="{ row }">
              <span v-if="row.wear?.rulWanKm !== null && row.wear?.rulWanKm !== undefined">{{ row.wear.rulWanKm }} 万km</span>
              <span v-else class="sub">—</span>
            </template>
          </el-table-column>
          <el-table-column label="到限天数" width="100" align="center">
            <template #default="{ row }">
              <span v-if="row.rulDays !== null" :style="{ color: row.rulDays <= 30 ? '#ff3d71' : '#e8edf3' }">{{ row.rulDays }} 天</span>
              <span v-else class="sub">—</span>
            </template>
          </el-table-column>
          <el-table-column label="建议更换里程" width="130" align="center">
            <template #default="{ row }">
              <span v-if="row.wear?.replaceMileageKm">{{ (row.wear.replaceMileageKm / 10000).toFixed(2) }} 万km</span>
              <span v-else class="sub">—</span>
            </template>
          </el-table-column>
          <el-table-column label="建议更换日期" width="130" align="center">
            <template #default="{ row }">{{ row.dueDate }}</template>
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
const scatterRef = ref(null)
let scatter = null

function withDays(row) {
  const days = Math.max(1, (Date.now() - new Date(row.commissionedAt).getTime()) / 86400000)
  const dailyKm = row.mileageKm / days
  const rulKm = row.wear?.rulWanKm != null ? row.wear.rulWanKm * 10000 : null
  const rulDays = rulKm != null && dailyKm > 0 ? Math.round(rulKm / dailyKm) : null
  let dueDate = '—'
  if (rulDays != null) {
    const d = new Date(Date.now() + rulDays * 86400000)
    dueDate = d.toISOString().slice(0, 10)
  }
  return { ...row, rulDays, dueDate }
}

const rows = computed(() => list.value.map(withDays))
const sorted = computed(() => [...rows.value].sort((a, b) => {
  const av = a.rulDays == null ? Infinity : a.rulDays
  const bv = b.rulDays == null ? Infinity : b.rulDays
  return av - bv
}))

const avgRate = computed(() => {
  const v = list.value.map((p) => p.wear?.wearRateMmPerWanKm).filter((x) => typeof x === 'number')
  if (!v.length) return '—'
  return (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)
})

const fastest = computed(() => {
  let best = { rate: null, train: '', line: '' }
  for (const p of list.value) {
    const r = p.wear?.wearRateMmPerWanKm
    if (typeof r === 'number' && (best.rate === null || r > best.rate)) {
      best = { rate: r, train: p.train, line: p.line }
    }
  }
  return best
})

const due30 = computed(() => rows.value.filter((r) => r.rulDays != null && r.rulDays <= 30).length)
const minThickness = computed(() => {
  if (!list.value.length) return '—'
  return Math.min(...list.value.map((p) => p.minThicknessMm)).toFixed(1)
})

function renderScatter() {
  if (!scatterRef.value) return
  if (!scatter) scatter = echarts.init(scatterRef.value, 'dark')
  const data = list.value.map((p) => ({
    value: [p.wear?.wearRateMmPerWanKm ?? 0, p.minThicknessMm],
    name: `${p.line} ${p.train}`,
    itemStyle: { color: p.health.color },
  }))
  scatter.setOption({
    tooltip: {
      backgroundColor: 'rgba(10,30,50,0.92)', borderColor: '#00c6ff', textStyle: { color: '#fff' },
      formatter: (o) => `${o.data.name}<br/>磨耗速率 ${o.value[0]} mm/万km<br/>剩余厚度 ${o.value[1]} mm`,
    },
    grid: { left: '5%', right: '5%', bottom: '12%', top: '12%', containLabel: true },
    xAxis: {
      type: 'value', name: '磨耗速率 (mm/万km)',
      axisLabel: { color: '#b0c4de' }, nameTextStyle: { color: '#b0c4de' },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
    },
    yAxis: {
      type: 'value', name: '剩余厚度 (mm)', min: 0, max: 42,
      axisLabel: { color: '#b0c4de' }, nameTextStyle: { color: '#b0c4de' },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
    },
    series: [{
      type: 'scatter', data, symbolSize: 16,
      label: { show: true, formatter: (o) => o.data.name, position: 'right', color: '#cfe3f7', fontSize: 11 },
      labelLayout: { hideOverlap: true },
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: '#ff3d71', type: 'dashed' },
        label: { color: '#ff3d71', formatter: '到限 10 mm' },
        data: [{ yAxis: 10 }],
      },
    }],
  }, true)
  scatter.resize()
}

function resize() { scatter?.resize() }

onMounted(async () => {
  try {
    const { data } = await api.get('/api/v3/pantographs')
    list.value = data.list || []
    await nextTick()
    renderScatter()
  } catch (err) {
    console.warn('磨耗预测加载失败', err.message)
  }
  window.addEventListener('resize', resize)
})
onUnmounted(() => {
  window.removeEventListener('resize', resize)
  scatter?.dispose()
})
</script>

<style scoped>
.chart { height: 320px; }
.sub { color: #7a8b9f; font-size: 12px; }
.method { font-size: 12px; color: #8fa6bd; line-height: 1.8; }
.method p { margin: 0 0 8px; }
.method b { color: #cfe3f7; }
.method .tip { color: #7a8b9f; border-left: 3px solid rgba(255,170,0,0.5); padding-left: 8px; margin-top: 10px; }
</style>
