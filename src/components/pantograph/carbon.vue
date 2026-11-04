<!-- 受电弓详情-受电弓信息 -->
<!--
  偏磨占比原为写死的 66%/17%/17%、56%/27%/17%，且图例重复"导高超限"。
  平台没有滑板厚度/偏磨的直接测量量，硬编码饼图属于虚构数据。
  现改为按真实告警构成绘制的 ECharts 饼图：
    · 部件告警页签：压力超限 / 导高超限 / 燃弧超限 / 拉出值超限
    · 环境预警页签：高温预警 / 低温预警 / 高湿预警 / 高压报警 / 低压报警
  数据源 /api/history（近 30 天），并为 WebSocket fullUpdate 实时刷新。
-->
<template>
  <div class="carbon">
    <el-tabs v-model="carbonTab" class="carbon-tabs" stretch>
      <el-tab-pane label="部件告警" name="part" />
      <el-tab-pane label="环境预警" name="env" />
    </el-tabs>

    <div class="carbon-body">
      <!-- 上方：碳滑板图片展示 -->
      <div class="carbon-img-wrap">
        <img :src="carbonContactStrip" style="width: 70%" alt="碳滑板" class="carbon-img" />
        <div class="carbon-img-label">碳滑板</div>
      </div>

      <!-- 下方：告警类型占比（近 30 天，真实数据） -->
      <div class="carbon-pie-wrap">
        <div class="carbon-pie-title">{{ title }}（近 30 天）</div>
        <div class="carbon-pie-chart">
          <div v-show="items.length > 0" ref="pieRef" class="carbon-pie-canvas"></div>
          <div v-if="items.length === 0" class="carbon-pie-empty">暂无记录</div>
        </div>
        <div class="carbon-pie-legend">
          <div class="legend-item" v-for="(it, i) in items" :key="it.name">
            {{ it.name }} {{ it.pct }}%
            <span class="legend-color" :style="{ background: COLORS[i % COLORS.length] }"></span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { storeToRefs } from 'pinia'
import carbonContactStrip from '@/assets/images/carbonGIF.gif'
import echarts from '@/utils/echarts'
import { useAlarmStore } from '@/stores/alarms'
import { PANTOGRAPH_ALARM_TYPES, ENV_ALARM_TYPES } from '@/utils/alarm-types'

const COLORS = ['#2ca7e0', '#1b8edb', '#0e6fb7', '#ffc107', '#5ad8a6']
const WINDOW_MS = 30 * 86400000

const carbonTab = ref('part')
const pieRef = ref(null)
let chart = null
// 全站共享列表（响应式 store），无需本组件重复拉取
const store = useAlarmStore()
const { list: allWarnings } = storeToRefs(store)

const TYPES = computed(() => (carbonTab.value === 'env' ? ENV_ALARM_TYPES : PANTOGRAPH_ALARM_TYPES))
const title = computed(() => (carbonTab.value === 'env' ? '环境预警构成' : '受电弓部件告警构成'))

const items = computed(() => {
  const cutoff = Date.now() - WINDOW_MS
  const counts = {}
  TYPES.value.forEach(t => { counts[t] = 0 })
  for (const w of allWarnings.value) {
    if (!counts.hasOwnProperty(w.content)) continue
    const t = new Date(w.timeFull || w.time).getTime()
    if (!Number.isFinite(t) || t < cutoff) continue
    counts[w.content] += 1
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (!total) return []
  return TYPES.value
    .filter(t => counts[t] > 0)
    .map(t => ({ name: t, value: counts[t], pct: Math.round((counts[t] / total) * 100) }))
    .sort((a, b) => b.value - a.value)
})

function render() {
  if (!pieRef.value) return
  if (items.value.length === 0) {
    if (chart) chart.clear()
    return
  }
  if (!chart) chart = echarts.init(pieRef.value, 'dark')
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', formatter: '{b}<br/>{c} 条（{d}%）' },
    series: [{
      type: 'pie',
      radius: ['45%', '72%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: true,
      label: { show: true, formatter: '{d}%', color: '#fff', fontSize: 12 },
      labelLine: { length: 6, length2: 6, lineStyle: { color: 'rgba(255,255,255,0.4)' } },
      data: items.value.map((it, i) => ({
        name: it.name,
        value: it.value,
        itemStyle: { color: COLORS[i % COLORS.length] },
      })),
    }],
    animationDuration: 600,
  }, true)
  chart.resize()
}

function handleResize() { chart && chart.resize() }

watch(carbonTab, async () => {
  await nextTick()
  if (chart && !pieRef.value) { chart.dispose(); chart = null }
  render()
})

// 列表变化（首屏 / WS 增量）→ 重算占比并重绘
watch(allWarnings, async () => {
  await nextTick()
  render()
})

onMounted(() => {
  store.bind()
  nextTick(render)
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  if (chart) { chart.dispose(); chart = null }
})
</script>

<style scoped>
.carbon {
  width: 30%;
  height: 100%;
  background: none;
  margin-right: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  box-sizing: border-box;
  padding: 10px 0;
  border-radius: 8px;
}
.carbon-tabs {
  width: 100%;
  --tab-bg: #7ad0ee;
  --tab-inactive: #b2d8e6;
  --tab-content-bg: rgba(10, 46, 93, 0.4);
}
.carbon :deep(.el-tabs__header) {
  background: none;
  border-bottom: none;
  margin-bottom: 0;
}
.carbon :deep(.el-tabs__nav) {
  border: none;
  background: none;
  overflow: hidden;
  border-radius: 5px 5px 0 0;
}
.carbon :deep(.el-tabs__item) {
  background: #132e5a;
  color: #fff;
  font-size: 18px;
  margin-right: 0;
  transition: background 0.2s, color 0.2s;
  border: none;
  min-width: 0;
  padding: 8px 0;
}
.carbon :deep(.el-tabs__item.is-active) {
  color: #fff;
}
.carbon :deep(.el-tabs__item:not(.is-active)) {
  color: #b2d8e6;
  font-weight: normal;
}
.carbon :deep(.el-tabs__active-bar) {
  background: #327ba1;
  height: 2px;
  border-radius: 2px 2px 0 0;
}
.carbon :deep(.el-tabs__content) {
  display: none;
}
.carbon-body {
  width: 100%;
  height: 100%;
  background: rgba(10, 46, 93, 0.4);
  border-radius: 0 0 8px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.carbon-img-wrap {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  margin: 20px 0 10px 0;
}
.carbon-img-label {
  position: absolute;
  left: 5%;
  top: 0;
  background: #fff;
  color: #222;
  border-radius: 8px;
  padding: 2px 14px;
  font-size: 16px;
  font-weight: bold;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}
.carbon-pie-wrap {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.carbon-pie-title {
  color: #fff;
  font-size: 16px;
  font-weight: bold;
  margin-bottom: 4px;
  text-align: center;
}
.carbon-pie-chart {
  width: 100%;
  max-width: 300px;
  height: 180px;
  position: relative;
  margin: 0 auto 4px auto;
  display: flex;
  align-items: center;
  justify-content: center;
}
.carbon-pie-canvas {
  width: 100%;
  height: 100%;
}
.carbon-pie-empty {
  color: #b0c4de;
  font-size: 14px;
}
.carbon-pie-legend {
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  margin-top: 6px;
  padding: 0 8px;
}
.legend-item {
  display: flex;
  align-items: center;
  color: #fff;
  font-size: 13px;
}
.legend-color {
  display: inline-block;
  width: 18px;
  height: 8px;
  margin-left: 6px;
}
</style>
