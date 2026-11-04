<template>
  <div class="v3-page">
    <div class="v3-head">
      <span class="v3-h1">弓网状态</span>
      <span class="v3-sub">接触力 / 导高 / 拉出值 / 燃弧率 —— 看的是弓与网的配合，不是滑板本身</span>
      <span class="v3-spacer" />
      <el-select v-model="selectedId" style="width: 240px" @change="loadDetail">
        <el-option v-for="p in list" :key="p.id" :value="p.id" :label="`${p.line} ${p.train}车 ${p.position}`" />
      </el-select>
    </div>

    <div class="v3-grid v3-grid-4">
      <div class="v3-kpi" :style="{ '--kpi-color': forceColor }">
        <div class="v3-kpi-label">平均接触力</div>
        <div class="v3-kpi-value">{{ cat.contactForceMeanN ?? '—' }}<small>N</small></div>
        <div class="v3-kpi-foot">EN 50367 静态 70–120 N</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#00c6ff">
        <div class="v3-kpi-label">接触力标准差</div>
        <div class="v3-kpi-value">{{ cat.contactForceStdN ?? '—' }}<small>N</small></div>
        <div class="v3-kpi-foot">工程关注线 8 N</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#ffaa00">
        <div class="v3-kpi-label">燃弧率</div>
        <div class="v3-kpi-value">{{ cat.arcRate ?? '—' }}<small>%</small></div>
        <div class="v3-kpi-foot">关注线 2%，越高取流越差</div>
      </div>
      <div class="v3-kpi" :style="{ '--kpi-color': (cat.violations24h || 0) > 0 ? '#ff3d71' : '#00d68f' }">
        <div class="v3-kpi-label">24h 越限次数</div>
        <div class="v3-kpi-value">{{ cat.violations24h ?? 0 }}<small>次</small></div>
        <div class="v3-kpi-foot">导高 / 拉出值 / 接触力综合</div>
      </div>
    </div>

    <div class="v3-row" style="margin-top:14px">
      <div class="v3-card" style="flex:1.25">
        <div class="v3-card-title">接触力限值带 <span class="hint">当前 {{ selectedLabel }}</span></div>
        <div class="band-wrap">
          <div class="band-track">
            <div class="band-ok" :style="{ left: pct(70) + '%', width: (pct(120) - pct(70)) + '%' }"></div>
            <div v-if="cat.contactForceMeanN != null" class="band-marker" :style="{ left: pct(cat.contactForceMeanN) + '%' }">
              <span class="marker-dot"></span>
              <span class="marker-label">{{ cat.contactForceMeanN }} N</span>
            </div>
          </div>
          <div class="band-scale">
            <span v-for="t in [50, 70, 90, 120, 140]" :key="t" :style="{ left: pct(t) + '%' }">{{ t }}</span>
          </div>
          <div class="band-note">绿色区间为 EN 50367 静态接触力允许带（70–120 N）；低于 70 N 取流不稳，高于 120 N 加速滑板磨耗。</div>
        </div>

        <div class="v3-grid v3-grid-2" style="margin-top:18px">
          <div class="mini">
            <div class="mini-label">导高</div>
            <div class="mini-value">{{ cat.heightMm ?? '—' }} <small>mm</small></div>
            <div class="mini-foot">标准 2400 mm</div>
          </div>
          <div class="mini">
            <div class="mini-label">拉出值</div>
            <div class="mini-value">{{ cat.staggerMm ?? '—' }} <small>mm</small></div>
            <div class="mini-foot">关注线 ±20 mm</div>
          </div>
        </div>
      </div>

      <div class="v3-card" style="flex:1">
        <div class="v3-card-title">车队弓网对比 <span class="hint">按接触力标准差升序</span></div>
        <div class="v3-table">
          <el-table :data="sorted" height="300" @row-click="pick" style="width:100%">
            <el-table-column label="列车" min-width="110">
              <template #default="{ row }">{{ row.line }} {{ row.train }}</template>
            </el-table-column>
            <el-table-column label="接触力" width="95" align="center">
              <template #default="{ row }">
                <span :style="{ color: row.catenary.contactForceMeanN < 70 || row.catenary.contactForceMeanN > 120 ? '#ff3d71' : '#e8edf3' }">
                  {{ row.catenary.contactForceMeanN }} N
                </span>
              </template>
            </el-table-column>
            <el-table-column label="标准差" width="80" align="center">
              <template #default="{ row }">{{ row.catenary.contactForceStdN }} N</template>
            </el-table-column>
            <el-table-column label="燃弧率" width="80" align="center">
              <template #default="{ row }">{{ row.catenary.arcRate }}%</template>
            </el-table-column>
            <el-table-column label="越限" width="70" align="center">
              <template #default="{ row }">
                <span class="v3-badge" :class="row.catenary.violations24h > 0 ? 'warn' : 'ok'">{{ row.catenary.violations24h }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import api from '@/utils/api'

const list = ref([])
const selectedId = ref('')
const cat = ref({})

const sorted = computed(() =>
  [...list.value].sort((a, b) => a.catenary.contactForceStdN - b.catenary.contactForceStdN),
)
const selectedLabel = computed(() => {
  const p = list.value.find((x) => x.id === selectedId.value)
  return p ? `${p.line} ${p.train}车 ${p.position}` : '—'
})
const forceColor = computed(() => {
  const v = cat.value.contactForceMeanN
  if (v == null) return '#00c6ff'
  return v < 70 || v > 120 ? '#ff3d71' : '#00d68f'
})

// 50~140 N 映射到 0~100%
function pct(v) {
  return Math.max(0, Math.min(100, ((v - 50) / 90) * 100))
}

function pick(row) {
  selectedId.value = row.id
  cat.value = row.catenary
}

async function loadDetail() {
  const p = list.value.find((x) => x.id === selectedId.value)
  if (p) cat.value = p.catenary
}

onMounted(async () => {
  try {
    const { data } = await api.get('/api/v3/pantographs')
    list.value = data.list || []
    if (list.value.length) {
      selectedId.value = list.value[0].id
      cat.value = list.value[0].catenary
    }
  } catch (err) {
    console.warn('弓网状态加载失败', err.message)
  }
})
</script>

<style scoped>
.band-wrap { padding: 8px 4px 0; }
.band-track {
  position: relative;
  height: 14px;
  border-radius: 7px;
  background: linear-gradient(90deg, rgba(255,61,113,0.25), rgba(255,255,255,0.06) 30%, rgba(255,255,255,0.06) 70%, rgba(255,61,113,0.25));
}
.band-ok {
  position: absolute;
  top: 0; bottom: 0;
  background: rgba(0, 214, 143, 0.28);
  border-left: 1px solid rgba(0,214,143,0.7);
  border-right: 1px solid rgba(0,214,143,0.7);
}
.band-marker { position: absolute; top: -6px; transform: translateX(-50%); }
.marker-dot {
  display: block;
  width: 6px; height: 26px;
  border-radius: 3px;
  background: #00c6ff;
  box-shadow: 0 0 10px rgba(0,198,255,0.8);
}
.marker-label {
  position: absolute;
  top: -22px; left: 50%;
  transform: translateX(-50%);
  font-size: 12px;
  color: #00c6ff;
  white-space: nowrap;
}
.band-scale {
  position: relative;
  height: 16px;
  margin-top: 8px;
  font-size: 11px;
  color: #7a8b9f;
}
.band-scale span {
  position: absolute;
  transform: translateX(-50%);
  white-space: nowrap;
}
.band-note { margin-top: 12px; font-size: 12px; color: #8fa6bd; line-height: 1.7; }
.mini {
  background: rgba(255,255,255,0.035);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 10px;
  padding: 10px 12px;
}
.mini-label { font-size: 12px; color: #8fa6bd; }
.mini-value { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px; }
.mini-value small { font-size: 12px; color: #8fa6bd; font-weight: 400; }
.mini-foot { font-size: 11px; color: #7a8b9f; }
:deep(.el-table__row) { cursor: pointer; }
</style>
