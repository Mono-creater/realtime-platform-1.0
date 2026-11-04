<template>
  <div class="strip-detail">
    <!-- 顶部：选择受电弓 -->
    <div class="toolbar">
      <span class="title">🔧 碳滑板管理</span>
      <el-select v-model="selectedId" placeholder="选择受电弓" style="width: 260px" @change="loadDetail">
        <el-option v-for="pg in list" :key="pg.id" :value="pg.id" :label="`${pg.line} ${pg.train}车 ${pg.position}（第${pg.stripSerial}块）`" />
      </el-select>
    </div>

    <template v-if="strip">
      <!-- 四测点厚度 -->
      <div class="card">
        <div class="card-title">📏 四测点剩余厚度（mm）</div>
        <div class="points-row">
          <div v-for="p in strip.points" :key="p.pos" class="point-card" :class="{ danger: p.thicknessMm < 15 }">
            <div class="point-pos">{{ p.pos }}</div>
            <div class="point-val" :style="{ color: p.thicknessMm < 15 ? '#ff3d71' : '#00d68f' }">{{ p.thicknessMm.toFixed(1) }}</div>
            <div class="point-unit">mm</div>
          </div>
          <div class="point-card summary">
            <div class="point-pos">偏磨差（max−min）</div>
            <div class="point-val" :style="{ color: '#ffaa00' }">{{ skew.toFixed(1) }}</div>
            <div class="point-unit">mm</div>
          </div>
        </div>
        <!-- 滑板俯视图（四测点 + 缺陷框选） -->
        <div class="strip-topview">
          <svg viewBox="0 0 600 90" class="strip-svg">
            <rect x="10" y="30" width="580" height="30" rx="8" fill="#3a3f4a" stroke="#555" />
            <text x="16" y="24" fill="#b0c4de" font-size="11">前端</text>
            <text x="520" y="24" fill="#b0c4de" font-size="11">后端</text>
            <!-- 四测点 -->
            <g v-for="(p, i) in strip.points" :key="p.pos">
              <circle :cx="40 + i * 170" cy="45" r="6" :fill="p.thicknessMm < 15 ? '#ff3d71' : '#00c6ff'" />
              <text :x="40 + i * 170" y="76" fill="#cfe3f7" font-size="10" text-anchor="middle">{{ p.thicknessMm.toFixed(1) }}</text>
            </g>
            <!-- 缺陷框选 -->
            <g v-for="(d, di) in strip.defects" :key="di">
              <rect :x="10 + d.x * 580" :y="30 + d.y * 30" :width="d.w * 580" :height="d.h * 30"
                fill="rgba(255,61,113,0.25)" stroke="#ff3d71" stroke-width="1.5" stroke-dasharray="4,2" />
              <text :x="10 + d.x * 580" :y="30 + d.y * 30 - 4" fill="#ff3d71" font-size="10">{{ d.type }} {{ d.confidence }}</text>
            </g>
          </svg>
          <div class="view-caption">滑板俯视示意（视觉检测缺陷框选，框内为 YOLO 检出目标）</div>
        </div>
      </div>

      <div class="mid-row">
        <!-- 磨耗趋势图 -->
        <div class="card chart-card">
          <div class="card-title">📉 磨耗趋势与剩余寿命预测</div>
          <div ref="wearChartRef" class="wear-chart"></div>
        </div>
        <!-- 缺陷列表 + 磨耗速率 -->
        <div class="card side-card">
          <div class="card-title">🔍 视觉检测缺陷</div>
          <div v-if="strip.defects.length" class="defect-list">
            <div v-for="(d, di) in strip.defects" :key="di" class="defect-item">
              <span class="defect-type">{{ d.type }}</span>
              <span class="defect-sev" :class="d.severity">{{ d.severity }}</span>
              <span class="defect-conf">置信度 {{ (d.confidence * 100).toFixed(0) }}%</span>
            </div>
          </div>
          <div v-else class="no-defect">未检出缺陷</div>
          <div class="wear-rate" v-if="strip.wear">
            <div class="wr-row"><span>磨耗速率</span><b>{{ strip.wear.wearRateMmPerWanKm }} mm/万 km</b></div>
            <div class="wr-row"><span>剩余寿命</span><b>{{ strip.wear.rulWanKm !== null ? strip.wear.rulWanKm + ' 万 km' : '—' }}</b></div>
            <div class="wr-row"><span>建议更换里程</span><b>{{ strip.wear.replaceMileageKm !== null ? (strip.wear.replaceMileageKm / 10000).toFixed(2) + ' 万 km' : '—' }}</b></div>
          </div>
        </div>
      </div>

      <!-- 回库视觉检测：视觉检测创新的业务落点（检测帧 + 缺陷框 + 模型指标） -->
      <div class="card" v-if="inspection && inspection.frames && inspection.frames.length">
        <div class="card-title">
          🔍 回库视觉检测
          <span class="model-badges">
            <span class="mb">{{ inspection.model.name }} {{ inspection.model.version }}</span>
            <span class="mb">mAP50 {{ (inspection.model.map50 * 100).toFixed(1) }}%</span>
            <span class="mb">mAP50-95 {{ (inspection.model.map5095 * 100).toFixed(1) }}%</span>
            <span class="mb">推理 {{ inspection.model.inferenceMs }} ms/帧</span>
          </span>
        </div>
        <div class="inspection">
          <!-- 左侧：检测帧列表 -->
          <div class="frame-list">
            <div
              v-for="(f, i) in inspection.frames"
              :key="f.id"
              class="frame-item"
              :class="{ active: i === selectedFrame }"
              @click="selectedFrame = i"
            >
              <div class="fi-date">{{ f.date }}</div>
              <div class="fi-mileage">{{ (f.mileageKm / 10000).toFixed(1) }} 万km · {{ f.thicknessMm.toFixed(1) }} mm</div>
              <div class="fi-foot">
                <span class="fi-defects">{{ f.defects.length }} 处缺陷</span>
                <span class="fi-concl" :class="conclClass(f.conclusion)">{{ f.conclusion }}</span>
              </div>
            </div>
          </div>

          <!-- 右侧：选定帧的检测图与缺陷明细 -->
          <div class="frame-view">
            <svg viewBox="0 0 620 120" class="inspect-svg">
              <defs>
                <linearGradient id="stripGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#4a4f59" />
                  <stop offset="50%" stop-color="#31353d" />
                  <stop offset="100%" stop-color="#24272d" />
                </linearGradient>
              </defs>
              <text x="12" y="18" fill="#7a8b9f" font-size="11">检测帧 {{ currentFrame.id }} · {{ currentFrame.station }}</text>
              <rect x="12" y="34" width="596" height="46" rx="9" fill="url(#stripGrad)" stroke="#5a6069" />
              <!-- 表面纹理 -->
              <line v-for="n in 24" :key="n" :x1="12 + n * 24.8" y1="36" :x2="12 + n * 24.8" y2="78" stroke="rgba(255,255,255,0.04)" />
              <!-- 缺陷框 -->
              <g v-for="(d, di) in currentFrame.defects" :key="di">
                <rect
                  :x="12 + d.x * 596" :y="34 + d.y * 46" :width="Math.max(18, d.w * 596)" :height="Math.max(14, d.h * 46)"
                  fill="rgba(255,61,113,0.18)" stroke="#ff3d71" stroke-width="1.5"
                />
                <rect :x="12 + d.x * 596" :y="34 + d.y * 46 - 15" :width="d.type.length * 11 + 46" height="14" fill="rgba(255,61,113,0.85)" rx="2" />
                <text :x="12 + d.x * 596 + 3" :y="34 + d.y * 46 - 4" fill="#fff" font-size="9">
                  {{ d.type }} {{ (d.confidence * 100).toFixed(0) }}%
                </text>
              </g>
              <text x="12" y="102" fill="#7a8b9f" font-size="10">前端</text>
              <text x="566" y="102" fill="#7a8b9f" font-size="10">后端</text>
            </svg>
            <div class="frame-meta">
              本次共 {{ currentFrame.images }} 张图 · 检出 {{ currentFrame.defects.length }} 处 ·
              检测时剩余厚度 {{ currentFrame.thicknessMm.toFixed(1) }} mm ·
              <span :class="conclClass(currentFrame.conclusion)">{{ currentFrame.conclusion }}</span>
            </div>
            <div class="defect-rows" v-if="currentFrame.defects.length">
              <div class="dr" v-for="(d, di) in currentFrame.defects" :key="di">
                <span class="dr-type">{{ d.type }}</span>
                <span class="dr-sev" :class="d.severity">{{ d.severity }}</span>
                <span class="dr-conf">置信度 {{ (d.confidence * 100).toFixed(0) }}%</span>
                <span class="dr-pos">位置 x{{ (d.x * 100).toFixed(0) }}% / y{{ (d.y * 100).toFixed(0) }}%</span>
              </div>
            </div>
            <div v-else class="no-defect">本帧未检出缺陷</div>
          </div>
        </div>
      </div>

      <!-- 换板记录 -->
      <div class="card">
        <div class="card-title">🔄 换板记录</div>
        <el-table :data="strip.replacements" border style="width:100%">
          <el-table-column prop="serial" label="滑板序号" width="100" align="center" />
          <el-table-column prop="date" label="更换日期" width="130" align="center" />
          <el-table-column label="更换时里程" width="140" align="center">
            <template #default="{ row }">{{ row.mileageKm > 0 ? (row.mileageKm / 10000).toFixed(1) + ' 万 km' : '出厂' }}</template>
          </el-table-column>
          <el-table-column prop="reason" label="更换原因" align="center" />
        </el-table>
      </div>
    </template>
    <div v-else class="loading">加载中…</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import echarts from '@/utils/echarts'
import api from '@/utils/api'

const list = ref([])
const selectedId = ref('')
const strip = ref(null)
const inspection = ref(null)
const selectedFrame = ref(0)
const wearChartRef = ref(null)
let wearChart = null

const skew = computed(() => {
  if (!strip.value) return 0
  const th = strip.value.points.map((p) => p.thicknessMm)
  return Math.max(...th) - Math.min(...th)
})

// 当前检测帧（默认展示最新一次；无记录时给安全兜底，避免模板取空属性）
const currentFrame = computed(() => {
  const frames = inspection.value?.frames || []
  return frames[selectedFrame.value] || {
    id: '—', date: '—', station: '—', images: 0, thicknessMm: 0,
    defects: [], conclusion: '—', mileageKm: 0,
  }
})

function conclClass(c) {
  if (c === '需更换') return 'danger'
  if (c === '需关注') return 'warn'
  return 'ok'
}

async function loadList() {
  try {
    const res = await api.get('/api/v3/pantographs')
    list.value = res.data.list || []
    if (list.value.length && !selectedId.value) {
      // 默认选中磨耗最严重（剩余厚度最小）的一架
      const worst = [...list.value].sort((a, b) => a.minThicknessMm - b.minThicknessMm)[0]
      selectedId.value = worst.id
      await loadDetail()
    }
  } catch (err) {
    console.warn('加载列表失败', err.message)
  }
}

async function loadDetail() {
  if (!selectedId.value) return
  try {
    const res = await api.get(`/api/v3/carbon-strip/${selectedId.value}`)
    strip.value = res.data.data.strip
    inspection.value = res.data.data.inspection || null
    // 默认展示最新一次检测（frames 按里程升序）
    selectedFrame.value = Math.max(0, (inspection.value?.frames?.length || 1) - 1)
    await nextTick()
    renderWearChart()
  } catch (err) {
    console.warn('加载滑板详情失败', err.message)
  }
}

function renderWearChart() {
  if (!wearChartRef.value || !strip.value) return
  if (!wearChart) wearChart = echarts.init(wearChartRef.value, 'dark')
  const history = strip.value.wearHistory
  const wear = strip.value.wear
  const LIMIT = 10
  const xs = history.map((p) => p.mileageKm)
  const ys = history.map((p) => p.thicknessMm)

  // 预测线：从当前点线性外推到到限（磨耗速率恒定）
  const currentMileage = xs[xs.length - 1]
  const currentT = ys[ys.length - 1]
  let predictX = [], predictY = []
  if (wear && wear.replaceMileageKm && wear.replaceMileageKm > currentMileage) {
    const rate = wear.wearRateMmPerWanKm / 10000 // mm/km
    predictX = [currentMileage, wear.replaceMileageKm]
    predictY = [currentT, LIMIT]
  }

  const option = {
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(10,30,50,0.9)', borderColor: '#00c6ff', textStyle: { color: '#fff' } },
    legend: { data: ['实测厚度', '预测', '到限线'], textStyle: { color: '#b0c4de' } },
    grid: { left: '6%', right: '4%', bottom: '8%', top: '10%', containLabel: true },
    xAxis: {
      type: 'value', name: '里程 (km)',
      axisLine: { lineStyle: { color: '#2a4a6a' } }, axisLabel: { color: '#b0c4de' },
      nameTextStyle: { color: '#b0c4de' },
      min: (v) => Math.floor(v.min / 1000) * 1000,
    },
    yAxis: {
      type: 'value', name: '剩余厚度 (mm)', min: 0, max: 42,
      axisLine: { lineStyle: { color: '#2a4a6a' } }, axisLabel: { color: '#b0c4de' },
      nameTextStyle: { color: '#b0c4de' },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
    },
    series: [
      {
        name: '实测厚度', type: 'line', data: history.map((p) => [p.mileageKm, p.thicknessMm]),
        symbol: 'circle', symbolSize: 7, smooth: false,
        lineStyle: { color: '#00c6ff', width: 3 }, itemStyle: { color: '#00c6ff' },
      },
      {
        name: '预测', type: 'line', data: predictX.map((x, i) => [x, predictY[i]]),
        symbol: 'none', lineStyle: { color: '#ffaa00', width: 2, type: 'dashed' },
        markPoint: predictX.length ? {
          data: [{ coord: [predictX[1], LIMIT], value: '建议更换', symbol: 'pin', symbolSize: 48, itemStyle: { color: '#ff3d71' } }],
          label: { color: '#fff', fontSize: 11 },
        } : undefined,
      },
      {
        name: '到限线', type: 'line', data: [[xs[0], LIMIT], [Math.max(xs[xs.length - 1], predictX[1] || 0), LIMIT]],
        symbol: 'none', lineStyle: { color: '#ff3d71', width: 1.5, type: 'dotted' },
        markLine: { silent: true, symbol: 'none', lineStyle: { color: '#ff3d71', type: 'dotted' }, label: { show: false }, data: [{ yAxis: LIMIT }] },
      },
    ],
  }
  wearChart.setOption(option, true)
  wearChart.resize()
}

function handleResize() { wearChart?.resize() }

onMounted(async () => {
  await loadList()
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  wearChart?.dispose()
})
</script>

<style scoped>
.strip-detail {
  width: 100%; height: 100%; box-sizing: border-box; padding: 16px;
  color: #fff; overflow-y: auto;
  background: radial-gradient(ellipse at 50% 0%, rgba(0, 198, 255, 0.05) 0%, transparent 70%);
  display: flex; flex-direction: column; gap: 16px;
}
.toolbar { display: flex; align-items: center; gap: 16px; }
.toolbar .title { font-size: 20px; font-weight: 600; color: #e0f0ff; }
.card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; padding: 16px 18px; }
.card-title { font-size: 15px; font-weight: 600; color: #cfe3f7; margin-bottom: 12px; }
.points-row { display: flex; gap: 12px; }
.point-card { flex: 1; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 10px; text-align: center; }
.point-card.danger { border-color: rgba(255,61,113,0.5); }
.point-pos { font-size: 12px; color: #7a8b9f; }
.point-val { font-size: 26px; font-weight: 700; }
.point-unit { font-size: 11px; color: #7a8b9f; }
.strip-topview { margin-top: 14px; }
.strip-svg { width: 100%; height: auto; background: rgba(0,0,0,0.2); border-radius: 10px; }
.view-caption { font-size: 12px; color: #7a8b9f; text-align: center; margin-top: 6px; }
.mid-row { display: flex; gap: 16px; }
.chart-card { flex: 1.6; }
.wear-chart { height: 300px; }
.side-card { flex: 1; }
.defect-list { display: flex; flex-direction: column; gap: 8px; }
.defect-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: rgba(255,61,113,0.08); border-radius: 8px; }
.defect-type { font-size: 14px; font-weight: 600; }
.defect-sev { font-size: 11px; border-radius: 8px; padding: 1px 8px; }
.defect-sev.高 { background: rgba(255,61,113,0.25); color: #ff3d71; }
.defect-sev.中 { background: rgba(255,170,0,0.25); color: #ffaa00; }
.defect-sev.低 { background: rgba(0,214,143,0.2); color: #00d68f; }
.defect-conf { margin-left: auto; font-size: 12px; color: #b0c4de; }
.no-defect { color: #7a8b9f; font-size: 13px; padding: 10px 0; }
.wear-rate { margin-top: 14px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px; }
.wr-row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 13px; color: #b0c4de; }
.wr-row b { color: #e8edf3; }
.loading { color: #7a8b9f; text-align: center; padding: 40px 0; }

/* 回库视觉检测 */
.model-badges { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
.model-badges .mb {
  font-size: 11px; font-weight: 400; color: #8fa6bd;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 9px; padding: 0 8px;
}
.inspection { display: flex; gap: 14px; }
.frame-list { width: 220px; flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; }
.frame-item {
  background: rgba(255,255,255,0.035);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 10px;
  padding: 8px 10px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.frame-item:hover { border-color: rgba(0,198,255,0.35); }
.frame-item.active { border-color: rgba(0,198,255,0.7); background: rgba(0,198,255,0.08); }
.fi-date { font-size: 13px; font-weight: 600; color: #e8edf3; }
.fi-mileage { font-size: 11px; color: #7a8b9f; margin: 2px 0 4px; }
.fi-foot { display: flex; align-items: center; justify-content: space-between; }
.fi-defects { font-size: 11px; color: #b9c9da; }
.fi-concl { font-size: 11px; padding: 0 7px; border-radius: 8px; }
.fi-concl.ok, .frame-meta .ok { color: #00d68f; background: rgba(0,214,143,0.12); }
.fi-concl.warn, .frame-meta .warn { color: #ffaa00; background: rgba(255,170,0,0.14); }
.fi-concl.danger, .frame-meta .danger { color: #ff3d71; background: rgba(255,61,113,0.14); }

.frame-view { flex: 1; min-width: 0; }
.inspect-svg { width: 100%; height: auto; background: rgba(0,0,0,0.22); border-radius: 10px; }
.frame-meta { font-size: 12px; color: #8fa6bd; margin: 8px 0; line-height: 1.7; }
.frame-meta span { padding: 0 6px; border-radius: 7px; }
.defect-rows { display: flex; flex-direction: column; gap: 6px; }
.dr {
  display: flex; align-items: center; gap: 10px;
  background: rgba(255,61,113,0.06);
  border: 1px solid rgba(255,61,113,0.15);
  border-radius: 8px; padding: 6px 10px; font-size: 12px;
}
.dr-type { font-weight: 600; color: #e8edf3; }
.dr-sev { font-size: 11px; border-radius: 8px; padding: 0 7px; }
.dr-sev.高 { background: rgba(255,61,113,0.25); color: #ff3d71; }
.dr-sev.中 { background: rgba(255,170,0,0.25); color: #ffaa00; }
.dr-sev.低 { background: rgba(0,214,143,0.2); color: #00d68f; }
.dr-conf { color: #b9c9da; }
.dr-pos { margin-left: auto; color: #7a8b9f; font-family: ui-monospace, monospace; }
:deep(.el-table) { background: transparent !important; }
:deep(.el-table th.el-table__cell) { background: rgba(10,46,93,0.6) !important; color: #fff !important; }
:deep(.el-table tr) { background: rgba(255,255,255,0.04) !important; color: #e8edf3; }
:deep(.el-table td.el-table__cell) { border-bottom: 1px solid rgba(255,255,255,0.04); }
</style>
