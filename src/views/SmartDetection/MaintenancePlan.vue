<template>
  <div class="v3-page">
    <div class="v3-head">
      <span class="v3-h1">检修计划</span>
      <span class="v3-sub">按剩余厚度、磨耗剩余寿命、3 域健康度自动排序 —— 工单是"已发生"，计划是"还没发生、但该做了"</span>
    </div>

    <div class="v3-grid v3-grid-4">
      <div class="v3-kpi" style="--kpi-color:#c9184a">
        <div class="v3-kpi-label">紧急</div>
        <div class="v3-kpi-value">{{ counts.紧急 }}<small>项</small></div>
        <div class="v3-kpi-foot">剩余寿命 ≤ 15 天或已接近到限</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#ff3d71">
        <div class="v3-kpi-label">高</div>
        <div class="v3-kpi-value">{{ counts.高 }}<small>项</small></div>
        <div class="v3-kpi-foot">剩余寿命 ≤ 60 天</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#ffaa00">
        <div class="v3-kpi-label">中</div>
        <div class="v3-kpi-value">{{ counts.中 }}<small>项</small></div>
        <div class="v3-kpi-foot">气路 / 弓网越限或健康度 &lt; 85</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#00d68f">
        <div class="v3-kpi-label">低</div>
        <div class="v3-kpi-value">{{ counts.低 }}<small>项</small></div>
        <div class="v3-kpi-foot">常规巡检</div>
      </div>
    </div>

    <div class="v3-card" style="margin-top:14px">
      <div class="v3-card-title">
        计划清单
        <span class="hint">优先级从高到低；依据列写明"为什么现在做"</span>
      </div>
      <div class="v3-table">
        <el-table :data="list" height="calc(100vh - 330px)" style="width:100%">
          <el-table-column label="优先级" width="85" align="center">
            <template #default="{ row }"><span class="v3-level" :class="row.level">{{ row.level }}</span></template>
          </el-table-column>
          <el-table-column label="列车 / 弓位" width="150">
            <template #default="{ row }">
              <div>{{ row.line }} {{ row.train }} 车</div>
              <div class="sub">{{ row.position }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="action" label="建议动作" width="130" align="center" />
          <el-table-column prop="reason" label="判定依据" min-width="320" />
          <el-table-column label="健康度" width="95" align="center">
            <template #default="{ row }">
              <span :style="{ color: healthColor(row.health), fontWeight: 600 }">{{ row.health }}</span>
              <span class="sub" style="margin-left:4px">{{ row.grade }}</span>
            </template>
          </el-table-column>
          <el-table-column label="剩余厚度" width="100" align="center">
            <template #default="{ row }">{{ row.minThicknessMm.toFixed(1) }} mm</template>
          </el-table-column>
          <el-table-column label="剩余寿命" width="100" align="center">
            <template #default="{ row }">
              <span v-if="row.rulDays !== null">{{ row.rulDays }} 天</span>
              <span v-else class="sub">—</span>
            </template>
          </el-table-column>
          <el-table-column label="建议更换里程" width="130" align="center">
            <template #default="{ row }">
              <span v-if="row.dueMileageKm">{{ (row.dueMileageKm / 10000).toFixed(2) }} 万km</span>
              <span v-else class="sub">—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div class="foot">
        口径说明：剩余寿命 =（当前厚度 − 到限 10 mm）÷ 磨耗速率；天数按本车投运以来的日均里程折算。
        计划为工程建议值，实际排程需结合天窗、备件与检修能力。
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import api from '@/utils/api'

const list = ref([])

const counts = computed(() => {
  const c = { 紧急: 0, 高: 0, 中: 0, 低: 0 }
  for (const p of list.value) c[p.level] = (c[p.level] || 0) + 1
  return c
})

function healthColor(v) {
  if (v >= 80) return '#00d68f'
  if (v >= 50) return '#ffaa00'
  return '#ff3d71'
}

onMounted(async () => {
  try {
    const { data } = await api.get('/api/v3/maintenance-plan')
    list.value = data.list || []
  } catch (err) {
    console.warn('检修计划加载失败', err.message)
  }
})
</script>

<style scoped>
.sub { color: #7a8b9f; font-size: 12px; }
.foot { margin-top: 12px; font-size: 12px; color: #7a8b9f; line-height: 1.7; }
</style>
