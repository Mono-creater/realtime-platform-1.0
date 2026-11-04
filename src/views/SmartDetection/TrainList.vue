<template>
  <div class="v3-page">
    <div class="v3-head">
      <span class="v3-h1">列车总览</span>
      <span class="v3-sub">按列车汇总受电弓档案、滑板剩余厚度与整弓健康度；点击行进入一弓一档</span>
    </div>

    <div class="v3-grid v3-grid-4">
      <div class="v3-kpi" style="--kpi-color:#00c6ff">
        <div class="v3-kpi-label">在册受电弓</div>
        <div class="v3-kpi-value">{{ fleet.total ?? '—' }}<small>架</small></div>
        <div class="v3-kpi-foot">覆盖 {{ fleet.lines ?? '—' }} 条线路</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#00d68f">
        <div class="v3-kpi-label">车队平均健康度</div>
        <div class="v3-kpi-value">{{ fleet.avgHealth ?? '—' }}</div>
        <div class="v3-kpi-foot">正常 {{ fleet.grades?.正常 ?? 0 }} · 关注 {{ fleet.grades?.关注 ?? 0 }}</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#ffaa00">
        <div class="v3-kpi-label">最薄剩余厚度</div>
        <div class="v3-kpi-value">{{ fleet.minThicknessMm ?? '—' }}<small>mm</small></div>
        <div class="v3-kpi-foot">到限 10 mm，低于即须更换</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#ff3d71">
        <div class="v3-kpi-label">需计划检修</div>
        <div class="v3-kpi-value">{{ (fleet.grades?.计划检修 ?? 0) + (fleet.grades?.立即检修 ?? 0) }}<small>架</small></div>
        <div class="v3-kpi-foot">计划检修 {{ fleet.grades?.计划检修 ?? 0 }} · 立即 {{ fleet.grades?.立即检修 ?? 0 }}</div>
      </div>
    </div>

    <div class="v3-card" style="margin-top:14px">
      <div class="v3-card-title">
        车队清单
        <span class="hint">按健康度升序，最需要处理的排在最前</span>
      </div>
      <div class="v3-table">
        <el-table :data="sorted" height="calc(100vh - 330px)" @row-click="goArchive" style="width:100%">
          <el-table-column prop="line" label="线路" width="90" align="center" />
          <el-table-column prop="train" label="车号" width="90" align="center" />
          <el-table-column prop="position" label="弓位" width="80" align="center" />
          <el-table-column label="累计里程" width="110" align="center">
            <template #default="{ row }">{{ (row.mileageKm / 10000).toFixed(1) }} 万km</template>
          </el-table-column>
          <el-table-column label="滑板" width="90" align="center">
            <template #default="{ row }">第 {{ row.stripSerial }} 块</template>
          </el-table-column>
          <el-table-column label="剩余厚度" width="110" align="center" sortable :sort-method="(a,b)=>a.minThicknessMm-b.minThicknessMm">
            <template #default="{ row }">
              <span :style="{ color: row.minThicknessMm <= 15 ? '#ff3d71' : '#e8edf3' }">{{ row.minThicknessMm.toFixed(1) }} mm</span>
            </template>
          </el-table-column>
          <el-table-column label="偏磨差" width="90" align="center">
            <template #default="{ row }">{{ row.skewMm }} mm</template>
          </el-table-column>
          <el-table-column label="磨耗速率" width="132" align="center">
            <template #default="{ row }">{{ row.wear?.wearRateMmPerWanKm ?? '—' }} mm/万km</template>
          </el-table-column>
          <el-table-column label="剩余寿命" width="118" align="center">
            <template #default="{ row }">
              <span v-if="row.wear?.rulWanKm !== null && row.wear?.rulWanKm !== undefined">{{ row.wear.rulWanKm }} 万km</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="整弓健康度" width="130" align="center" sortable :sort-method="(a,b)=>a.health.overall-b.health.overall">
            <template #default="{ row }">
              <span :style="{ color: row.health.color, fontWeight: 600 }">{{ row.health.overall }}</span>
              <span class="v3-badge" :class="gradeClass(row.health.grade)" style="margin-left:6px">{{ row.health.grade }}</span>
            </template>
          </el-table-column>
          <el-table-column label="最近检测" min-width="120" align="center">
            <template #default="{ row }">
              <span v-if="row.lastInspection">{{ row.lastInspection.date }} · {{ row.lastInspection.conclusion }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/utils/api'

const router = useRouter()
const list = ref([])
const fleet = ref({})

const sorted = computed(() => [...list.value].sort((a, b) => a.health.overall - b.health.overall))

function gradeClass(g) {
  if (g === '正常') return 'ok'
  if (g === '关注') return 'info'
  if (g === '计划检修') return 'warn'
  return 'danger'
}

function goArchive(row) {
  router.push({ name: 'PantographArchive', query: { id: row.id } })
}

onMounted(async () => {
  try {
    const [a, b] = await Promise.all([
      api.get('/api/v3/pantographs'),
      api.get('/api/v3/fleet'),
    ])
    list.value = a.data.list || []
    fleet.value = b.data.data || {}
  } catch (err) {
    console.warn('列车总览加载失败', err.message)
  }
})
</script>

<style scoped>
.muted { color: #7a8b9f; }
:deep(.el-table__row) { cursor: pointer; }
</style>
