<template>
  <div class="reports">
    <div class="toolbar">
      <span class="title">📊 报表中心</span>
      <el-button size="small" type="primary" @click="exportFleet">导出车队健康度 CSV</el-button>
    </div>

    <!-- 车队健康度汇总 -->
    <div class="card">
      <div class="card-title">受电弓车队健康度汇总（一弓一档 · 3 域）</div>
      <el-table :data="list" border style="width:100%">
        <el-table-column prop="line" label="线路" width="90" align="center" />
        <el-table-column prop="train" label="车号" width="90" align="center" />
        <el-table-column prop="position" label="位置" width="90" align="center" />
        <el-table-column label="累计里程" width="110" align="center">
          <template #default="{ row }">{{ (row.mileageKm / 10000).toFixed(1) }} 万 km</template>
        </el-table-column>
        <el-table-column label="滑板" width="110" align="center">
          <template #default="{ row }">第 {{ row.stripSerial }} 块 / 剩 {{ row.minThicknessMm }} mm</template>
        </el-table-column>
        <el-table-column label="滑板域" width="80" align="center">
          <template #default="{ row }"><b :style="{color: colorOf(row.health.domains.strip)}">{{ row.health.domains.strip }}</b></template>
        </el-table-column>
        <el-table-column label="气路域" width="80" align="center">
          <template #default="{ row }"><b :style="{color: colorOf(row.health.domains.air)}">{{ row.health.domains.air }}</b></template>
        </el-table-column>
        <el-table-column label="弓网域" width="80" align="center">
          <template #default="{ row }"><b :style="{color: colorOf(row.health.domains.catenary)}">{{ row.health.domains.catenary }}</b></template>
        </el-table-column>
        <el-table-column label="整弓" width="90" align="center">
          <template #default="{ row }"><b :style="{color: row.health.color}">{{ row.health.overall }}</b></template>
        </el-table-column>
        <el-table-column prop="health.grade" label="等级" width="90" align="center">
          <template #default="{ row }"><el-tag size="small" :color="row.health.color" effect="dark">{{ row.health.grade }}</el-tag></template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 统计指标 -->
    <div class="stat-row">
      <div class="stat-card" v-for="s in stats" :key="s.label">
        <div class="stat-value" :style="{ color: s.color }">{{ s.value }}</div>
        <div class="stat-label">{{ s.label }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import api from '@/utils/api'

const list = ref([])
const summary = ref({})

function colorOf(score) {
  if (score >= 80) return '#00d68f'
  if (score >= 50) return '#ffaa00'
  return '#ff3d71'
}

const stats = computed(() => {
  const fleet = list.value
  const avg = fleet.length ? Math.round(fleet.reduce((s, p) => s + p.health.overall, 0) / fleet.length) : 0
  const worst = fleet.length ? Math.min(...fleet.map((p) => p.health.overall)) : 0
  const nearLimit = fleet.filter((p) => p.minThicknessMm < 15).length
  return [
    { label: '受电弓总数', value: fleet.length, color: '#fff' },
    { label: '车队平均健康度', value: avg, color: colorOf(avg) },
    { label: '最低健康度', value: worst, color: colorOf(worst) },
    { label: '滑板接近到限（<15mm）', value: nearLimit, color: nearLimit ? '#ff3d71' : '#00d68f' },
  ]
})

async function loadData() {
  try {
    const [p, s] = await Promise.all([
      api.get('/api/v3/pantographs'),
      api.get('/api/stats/summary').catch(() => ({ data: {} })),
    ])
    list.value = p.data.list || []
    summary.value = s.data || {}
  } catch (err) {
    console.warn('加载报表失败', err.message)
  }
}

function exportFleet() {
  if (!list.value.length) return
  const head = '线路,车号,位置,累计里程万km,滑板序号,剩余厚度mm,滑板域,气路域,弓网域,整弓健康度,等级\n'
  const rows = list.value.map((p) => [
    p.line, p.train, p.position, (p.mileageKm / 10000).toFixed(1), p.stripSerial, p.minThicknessMm,
    p.health.domains.strip, p.health.domains.air, p.health.domains.catenary, p.health.overall, p.health.grade,
  ].join(',')).join('\n')
  const blob = new Blob(['\ufeff' + head + rows], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = '受电弓车队健康度.csv'
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(loadData)
</script>

<style scoped>
.reports {
  width: 100%; height: 100%; box-sizing: border-box; padding: 16px; color: #fff; overflow-y: auto;
  background: radial-gradient(ellipse at 50% 0%, rgba(0, 198, 255, 0.05) 0%, transparent 70%);
  display: flex; flex-direction: column; gap: 16px;
}
.toolbar { display: flex; align-items: center; justify-content: space-between; }
.toolbar .title { font-size: 20px; font-weight: 600; color: #e0f0ff; }
.card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; padding: 16px 18px; }
.card-title { font-size: 15px; font-weight: 600; color: #cfe3f7; margin-bottom: 12px; }
.stat-row { display: flex; gap: 16px; }
.stat-card { flex: 1; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 18px; text-align: center; }
.stat-value { font-size: 34px; font-weight: 700; }
.stat-label { font-size: 13px; color: #b0c4de; margin-top: 4px; }
:deep(.el-table) { background: transparent !important; }
:deep(.el-table th.el-table__cell) { background: rgba(10,46,93,0.6) !important; color: #fff !important; }
:deep(.el-table tr) { background: rgba(255,255,255,0.04) !important; color: #e8edf3; }
:deep(.el-table td.el-table__cell) { border-bottom: 1px solid rgba(255,255,255,0.04); }
</style>
