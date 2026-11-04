<template>
  <!-- 线路监控模块 -- 线路信息 -->
  <div class="omInfo">
    <!-- 部分一：选择+工具栏 -->
    <div class="tools">
      <div class="left">
        <el-select v-model="selectedLine" placeholder="请选择" size="small" style="width: 100px">
          <el-option
            v-for="item in options"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          />
        </el-select>
        <span class="left-tips">线路监控</span>
      </div>
      <div class="right">
        <div class="tool-item" v-for="(item, index) in tools" :key="index">
          <img :src="item.icon" alt="" width="15" />
          <span>{{ item.label }}</span>
        </div>
      </div>
    </div>

    <!-- 部分二：数据仪表盘 -->
    <div class="gaugesData">
      <!-- 动态线路图标（SVG） -->
      <img :src="currentLineIcon" width="100" alt="线路图标" />
      <!-- 仪表盘数据展示 -->
      <div class="gauges">
        <div class="gauge-item" v-for="(item, idx) in gaugeList" :key="idx">
          <dashboard-gauge
            :title="item.title"
            :value="item.value"
            :theme="item.theme"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import DashboardGauge from '@/components/DashboardGauge.vue'

// 导入工具栏图标（原路径保持不变）
import locationIcon from '@/assets/icons/location.png'
import detectIcon from '@/assets/icons/detect.png'
import fixIcon from '@/assets/icons/fix.png'
import decideIcon from '@/assets/icons/decide.png'
import analysisIcon from '@/assets/icons/analysis.png'
import searchIcon from '@/assets/icons/search.png'
import settingIcon from '@/assets/icons/setting.png'

// ---------- 下拉菜单 ----------
const selectedLine = ref(5) // 默认 5 号线

const options = [
  { value: 1, label: '1号线' },
  { value: 2, label: '2号线' },
  { value: 3, label: '3号线' },
  { value: 4, label: '4号线' },
  { value: 5, label: '5号线' },
  { value: 6, label: '6号线' },
  { value: 7, label: '7号线' },
  { value: 8, label: '8号线' },
  { value: 9, label: '9号线' },
  { value: 10, label: '10号线' },
  { value: 11, label: '11号线' },
  { value: 12, label: '12号线' },
  { value: 13, label: '13号线' },
]

// ---------- 工具栏 ----------
const tools = [
  { label: '健康检测', icon: locationIcon },
  { label: '健康管理', icon: detectIcon },
  { label: '状态维修', icon: fixIcon },
  { label: '运营决策', icon: decideIcon },
  { label: '统计分析', icon: analysisIcon },
  { label: '综合查询', icon: searchIcon },
  { label: '系统管理', icon: settingIcon },
]

// ---------- 线路图标动态路径（改为 .svg） ----------
const currentLineIcon = computed(() => {
  // 使用 Vite 的 import.meta.url 动态加载 SVG 文件
  return new URL(`../assets/LineIcons/Line${selectedLine.value}.svg`, import.meta.url).href
})

// ---------- 仪表盘数据（模拟） ----------
const lineDataMap = {
  1: { total: 48, run: 20, notRun: 28, alarm: 0, rate: 12 },
  2: { total: 52, run: 24, notRun: 28, alarm: 1, rate: 11 },
  3: { total: 50, run: 22, notRun: 28, alarm: 0, rate: 14 },
  4: { total: 49, run: 21, notRun: 28, alarm: 2, rate: 10 },
  5: { total: 51, run: 22, notRun: 29, alarm: 1, rate: 15 },
  6: { total: 53, run: 23, notRun: 30, alarm: 0, rate: 13 },
  7: { total: 47, run: 19, notRun: 28, alarm: 1, rate: 12 },
  8: { total: 55, run: 25, notRun: 30, alarm: 0, rate: 16 },
  9: { total: 46, run: 20, notRun: 26, alarm: 2, rate: 9 },
  10: { total: 54, run: 24, notRun: 30, alarm: 1, rate: 14 },
  11: { total: 50, run: 21, notRun: 29, alarm: 0, rate: 11 },
  12: { total: 49, run: 20, notRun: 29, alarm: 1, rate: 13 },
  13: { total: 52, run: 22, notRun: 30, alarm: 0, rate: 12 },
}

const currentLineData = computed(() => {
  return lineDataMap[selectedLine.value] || lineDataMap[5]
})

const gaugeConfig = [
  { key: 'total', title: '投运车辆', theme: 'blue' },
  { key: 'run', title: '运营车辆', theme: 'cyan' },
  { key: 'notRun', title: '非运营车辆', theme: 'purple' },
  { key: 'alarm', title: '故障告警车辆', theme: 'lightPurple' },
  { key: 'rate', title: '乘车率', theme: 'orange' },
]

const gaugeList = computed(() => {
  const data = currentLineData.value
  return gaugeConfig.map(item => ({
    ...item,
    value: item.key === 'rate' ? `${data[item.key]}%` : data[item.key]
  }))
})

// 监听线路变化
watch(selectedLine, (newVal) => {
  console.log(`切换到线路: ${newVal}号线`)
  // 如需通知父组件，可在此 emit
})

// 如果需要将选中的线路暴露给父组件，可定义 emit
// const emit = defineEmits(['lineChange'])
// watch(selectedLine, (val) => emit('lineChange', val))
</script>

<style scoped>
.tools {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.tools .left {
  font-size: 14px;
}
.tools .left-tips {
  margin-left: 5px;
  color: #fff;
  font-size: 12px;
}
.tools .right {
  display: flex;
  gap: 5px;
  font-size: 9px;
}
.tools .right .tool-item {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: #77c1db;
  gap: 5px;
  cursor: pointer;
}
:deep(.el-select .el-select__wrapper) {
  background: transparent !important;
  box-shadow: none !important;
  border: 1px solid #fff;
}
:deep(.el-select-dropdown) {
  background: rgba(0, 0, 0, 0.5) !important;
  box-shadow: none !important;
}
.gaugesData {
  display: flex;
  align-items: center;
  gap: 40px;
  margin-top: 20px;
  border-radius: 18px;
  padding: 20px 10px;
}
.gauges {
  display: flex;
  align-items: center;
  justify-content: space-around;
  gap: 80px;
}
</style>