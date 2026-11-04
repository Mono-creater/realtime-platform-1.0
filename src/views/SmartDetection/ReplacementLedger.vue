<template>
  <div class="v3-page">
    <div class="v3-head">
      <span class="v3-h1">换板台账</span>
      <span class="v3-sub">全车队碳滑板更换记录 —— 哪列车、哪架弓、第几块、什么原因、换在多少公里</span>
      <span class="v3-spacer" />
      <el-select v-model="lineFilter" clearable placeholder="全部线路" style="width: 150px">
        <el-option v-for="l in lines" :key="l" :value="l" :label="l" />
      </el-select>
    </div>

    <div class="v3-grid v3-grid-4">
      <div class="v3-kpi" style="--kpi-color:#00c6ff">
        <div class="v3-kpi-label">累计换板</div>
        <div class="v3-kpi-value">{{ list.length }}<small>次</small></div>
        <div class="v3-kpi-foot">覆盖 {{ lines.length }} 条线路</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#ffaa00">
        <div class="v3-kpi-label">磨耗到限占比</div>
        <div class="v3-kpi-value">{{ wearRatio }}<small>%</small></div>
        <div class="v3-kpi-foot">其余为偏磨 / 定期更换</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#00d68f">
        <div class="v3-kpi-label">平均换板间隔</div>
        <div class="v3-kpi-value">{{ avgInterval }}<small>万km</small></div>
        <div class="v3-kpi-foot">按同一受电弓相邻两次更换里程差</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#7be5e5">
        <div class="v3-kpi-label">近 12 个月</div>
        <div class="v3-kpi-value">{{ last12m }}<small>次</small></div>
        <div class="v3-kpi-foot">用于备件消耗与预算测算</div>
      </div>
    </div>

    <div class="v3-card" style="margin-top:14px">
      <div class="v3-card-title">
        更换明细
        <span class="hint">共 {{ filtered.length }} 条，按日期倒序</span>
      </div>
      <div class="v3-table">
        <el-table :data="filtered" height="calc(100vh - 330px)" style="width:100%">
          <el-table-column prop="date" label="更换日期" width="120" align="center" sortable />
          <el-table-column prop="line" label="线路" width="90" align="center" />
          <el-table-column prop="train" label="车号" width="90" align="center" />
          <el-table-column prop="position" label="弓位" width="85" align="center" />
          <el-table-column label="滑板序号" width="100" align="center">
            <template #default="{ row }">第 {{ row.serial }} 块</template>
          </el-table-column>
          <el-table-column label="更换时里程" width="130" align="center">
            <template #default="{ row }">
              {{ row.mileageKm > 0 ? (row.mileageKm / 10000).toFixed(1) + ' 万km' : '出厂' }}
            </template>
          </el-table-column>
          <el-table-column label="更换原因" min-width="140" align="center">
            <template #default="{ row }">
              <span class="v3-badge" :class="reasonClass(row.reason)">{{ row.reason }}</span>
            </template>
          </el-table-column>
          <el-table-column label="受电弓档案" min-width="260">
            <template #default="{ row }">
              <span class="ctx">{{ row.pantographId }}</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import api from '@/utils/api'

const list = ref([])
const lineFilter = ref('')

const lines = computed(() => [...new Set(list.value.map((r) => r.line))])
const filtered = computed(() =>
  lineFilter.value ? list.value.filter((r) => r.line === lineFilter.value) : list.value,
)

const wearRatio = computed(() => {
  if (!list.value.length) return '—'
  const n = list.value.filter((r) => r.reason === '磨耗到限').length
  return Math.round((n / list.value.length) * 1000) / 10
})

// 同一受电弓相邻两次更换的里程差（仅统计有里程的换板）
const avgInterval = computed(() => {
  const byPg = {}
  for (const r of list.value) {
    if (r.mileageKm <= 0) continue
    ;(byPg[r.pantographId] ||= []).push(r.mileageKm)
  }
  const gaps = []
  for (const arr of Object.values(byPg)) {
    const s = arr.sort((a, b) => a - b)
    for (let i = 1; i < s.length; i++) gaps.push(s[i] - s[i - 1])
  }
  if (!gaps.length) return '—'
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
  return (avg / 10000).toFixed(1)
})

const last12m = computed(() => {
  const cutoff = new Date()
  cutoff.setFullYear(cutoff.getFullYear() - 1)
  const s = cutoff.toISOString().slice(0, 10)
  return list.value.filter((r) => r.date >= s).length
})

function reasonClass(reason) {
  if (reason === '磨耗到限') return 'warn'
  if (reason === '偏磨超限') return 'danger'
  if (reason === '出厂安装') return 'mute'
  return 'info'
}

onMounted(async () => {
  try {
    const { data } = await api.get('/api/v3/replacements')
    list.value = data.list || []
  } catch (err) {
    console.warn('换板台账加载失败', err.message)
  }
})
</script>

<style scoped>
.ctx { color: #7a8b9f; font-size: 12px; font-family: ui-monospace, monospace; }
</style>
