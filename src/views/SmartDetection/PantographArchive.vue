<template>
  <div class="panto-archive">
    <!-- 左侧：受电弓档案列表 -->
    <div class="left-panel">
      <div class="panel-title">受电弓档案（一弓一档）</div>
      <div class="archive-list">
        <div
          v-for="pg in list"
          :key="pg.id"
          class="archive-item"
          :class="{ active: pg.id === selectedId }"
          @click="select(pg)"
        >
          <div class="item-top">
            <span class="item-train">{{ pg.train }} 车</span>
            <span class="item-tag" :style="{ color: pg.health.color, borderColor: pg.health.color }">
              {{ pg.health.overall }}·{{ pg.health.grade }}
            </span>
          </div>
          <div class="item-sub">{{ pg.line }} · {{ pg.position }}</div>
          <div class="item-sub2">累计 {{ (pg.mileageKm / 10000).toFixed(1) }} 万 km · 第 {{ pg.stripSerial }} 块滑板</div>
        </div>
      </div>
    </div>

    <!-- 右侧：详情 -->
    <div class="right-panel">
      <template v-if="detail">
        <!-- 档案六项 -->
        <div class="card archive-card">
          <div class="card-title">📁 受电弓档案</div>
          <div class="archive-grid">
            <div class="kv"><span class="k">车号</span><span class="v">{{ detail.train }}</span></div>
            <div class="kv"><span class="k">线路</span><span class="v">{{ detail.line }}</span></div>
            <div class="kv"><span class="k">安装位置</span><span class="v">{{ detail.position }}</span></div>
            <div class="kv"><span class="k">投运日期</span><span class="v">{{ detail.commissionedAt }}</span></div>
            <div class="kv"><span class="k">累计里程</span><span class="v">{{ (detail.mileageKm / 10000).toFixed(1) }} 万 km</span></div>
            <div class="kv"><span class="k">上次换板里程</span><span class="v">{{ (detail.lastStripMileageKm / 10000).toFixed(1) }} 万 km</span></div>
          </div>
          <div class="context-banner">🔍 {{ detail.context }}</div>
        </div>

        <div class="mid-row">
          <!-- 3 域雷达 -->
          <div class="card radar-card">
            <div class="card-title">🎯 3 域健康度（加权扣分）</div>
            <div ref="radarRef" class="radar"></div>
            <div class="domain-legend">
              <span class="dl">滑板 <b :style="{color: domainColor(detail.health.domains.strip)}">{{ detail.health.domains.strip }}</b></span>
              <span class="dl">气路 <b :style="{color: domainColor(detail.health.domains.air)}">{{ detail.health.domains.air }}</b></span>
              <span class="dl">弓网 <b :style="{color: domainColor(detail.health.domains.catenary)}">{{ detail.health.domains.catenary }}</b></span>
            </div>
          </div>

          <!-- 整弓健康度 -->
          <div class="card overall-card">
            <div class="card-title">🩺 整弓健康度</div>
            <div class="overall-score" :style="{ color: detail.health.color }">{{ detail.health.overall }}</div>
            <div class="overall-grade" :style="{ color: detail.health.color }">{{ detail.health.grade }}</div>
            <div class="overall-note">权重：滑板 50% · 气路 25% · 弓网 25%</div>
          </div>
        </div>

        <!-- 时间轴 -->
        <div class="card timeline-card">
          <div class="card-title">📅 全生命周期时间轴</div>
          <div class="timeline">
            <div v-for="(e, i) in detail.timeline" :key="i" class="tl-item">
              <div class="tl-dot" :class="e.type"></div>
              <div class="tl-date">{{ e.date }}</div>
              <div class="tl-label">{{ e.label }}</div>
              <div class="tl-mileage">{{ e.mileageKm > 0 ? (e.mileageKm / 10000).toFixed(1) + ' 万 km' : '出厂' }}</div>
            </div>
          </div>
        </div>
      </template>
      <div v-else class="loading">加载中…</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import echarts from '@/utils/echarts'
import api from '@/utils/api'

const route = useRoute()

const list = ref([])
const selectedId = ref('')
const detail = ref(null)
const radarRef = ref(null)
let radarChart = null

function domainColor(score) {
  if (score >= 80) return '#00d68f'
  if (score >= 50) return '#ffaa00'
  return '#ff3d71'
}

async function loadList() {
  try {
    const res = await api.get('/api/v3/pantographs')
    list.value = res.data.list || []
    if (list.value.length && !selectedId.value) {
      // 支持从"列车总览"带 id 跳转；未带 id 时默认选中健康度最低（最需关注）的一架
      const wanted = route.query.id && list.value.find((p) => p.id === route.query.id)
      const target = wanted || [...list.value].sort((a, b) => a.health.overall - b.health.overall)[0]
      await select(target)
    }
  } catch (err) {
    console.warn('加载受电弓档案失败', err.message)
  }
}

async function select(pg) {
  selectedId.value = pg.id
  try {
    const res = await api.get(`/api/v3/pantograph/${pg.id}`)
    detail.value = res.data.data
    await nextTick()
    renderRadar()
  } catch (err) {
    console.warn('加载详情失败', err.message)
  }
}

function renderRadar() {
  if (!radarRef.value || !detail.value) return
  if (!radarChart) radarChart = echarts.init(radarRef.value, 'dark')
  const d = detail.value.health.domains
  radarChart.setOption({
    tooltip: {},
    radar: {
      indicator: [
        { name: '滑板', max: 100 },
        { name: '气路', max: 100 },
        { name: '弓网', max: 100 },
      ],
      radius: '65%',
      axisName: { color: '#b0c4de', fontSize: 13 },
      splitArea: { areaStyle: { color: ['rgba(0,198,255,0.03)', 'rgba(0,198,255,0.06)'] } },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
    },
    series: [{
      type: 'radar',
      data: [{
        value: [d.strip, d.air, d.catenary],
        name: '健康度',
        areaStyle: { color: 'rgba(0,198,255,0.25)' },
        lineStyle: { color: '#00c6ff', width: 2 },
        itemStyle: { color: '#00c6ff' },
      }],
    }],
  }, true)
  radarChart.resize()
}

function handleResize() {
  radarChart?.resize()
}

watch(selectedId, () => {})

onMounted(async () => {
  await loadList()
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  radarChart?.dispose()
})
</script>

<style scoped>
.panto-archive {
  display: flex;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 16px;
  gap: 16px;
  color: #fff;
  background: radial-gradient(ellipse at 50% 0%, rgba(0, 198, 255, 0.05) 0%, transparent 70%);
  overflow: hidden;
}
.left-panel {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.panel-title {
  font-size: 16px;
  font-weight: 600;
  color: #e0f0ff;
}
.archive-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.archive-item {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  padding: 12px 14px;
  cursor: pointer;
  transition: all 0.2s;
}
.archive-item:hover { border-color: rgba(0,198,255,0.4); }
.archive-item.active { border-color: #00c6ff; background: rgba(0,198,255,0.08); }
.item-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.item-train { font-size: 16px; font-weight: 600; }
.item-tag { font-size: 12px; border: 1px solid; border-radius: 10px; padding: 1px 8px; }
.item-sub { font-size: 13px; color: #b0c4de; }
.item-sub2 { font-size: 12px; color: #7a8b9f; margin-top: 2px; }

.right-panel {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.card {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 14px;
  padding: 16px 18px;
}
.card-title { font-size: 15px; font-weight: 600; color: #cfe3f7; margin-bottom: 12px; }
.archive-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.kv { display: flex; flex-direction: column; gap: 2px; }
.kv .k { font-size: 12px; color: #7a8b9f; }
.kv .v { font-size: 16px; font-weight: 600; color: #e8edf3; }
.context-banner {
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(0,198,255,0.08);
  border: 1px solid rgba(0,198,255,0.2);
  color: #7ee0d8;
  font-size: 13px;
  line-height: 1.6;
}
.mid-row { display: flex; gap: 16px; }
.radar-card { flex: 1.4; }
.radar { height: 240px; }
.overall-card { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.overall-score { font-size: 64px; font-weight: 700; line-height: 1; }
.overall-grade { font-size: 18px; margin-top: 6px; }
.overall-note { font-size: 12px; color: #7a8b9f; margin-top: 10px; }
.domain-legend { display: flex; gap: 18px; justify-content: center; margin-top: 6px; }
.dl { font-size: 13px; color: #b0c4de; }
.dl b { font-size: 15px; }
.timeline { display: flex; flex-direction: column; gap: 0; }
.tl-item { display: flex; align-items: center; gap: 12px; padding: 8px 0; position: relative; }
.tl-dot { width: 10px; height: 10px; border-radius: 50%; background: #00c6ff; flex-shrink: 0; }
.tl-dot.换板 { background: #ffaa00; }
.tl-date { width: 90px; color: #b0c4de; font-size: 13px; }
.tl-label { flex: 1; color: #e8edf3; font-size: 13px; }
.tl-mileage { color: #7a8b9f; font-size: 12px; }
.loading { color: #7a8b9f; text-align: center; padding: 40px 0; }
</style>
