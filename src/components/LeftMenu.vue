<template>
  <!--
    左侧导航：四个业务域 + 系统。
    评审意见 (4)：原版四个一级菜单挂同一批子页（四个"全局监测"入口，内容一样）。
    3.0 的处理是【保留四个业务域】、但每个二级项各指向独立页面：
      智慧监测 —— 看现状（线网/线路/档案/告警）
      智慧列车 —— 看单车（列车总览/弓网状态/碳滑板状态）
      智慧检修 —— 看作业（工单/换板台账/检修计划）
      智慧分析 —— 看结论（故障分析/磨耗预测/健康度/报表）
    每个 index 唯一对应一个路由，不再出现重复入口。
  -->
  <div class="menu">
    <el-menu
      :default-active="activeKey"
      :default-openeds="openedGroups"
      class="el-menu-vertical-demo"
      background-color="transparent"
      text-color="#cfe3f7"
      active-text-color="#00c6ff"
      @select="handleMenuSelect"
    >
      <el-sub-menu index="g-monitor">
        <template #title>
          <el-icon><Odometer /></el-icon>
          <span>智慧监测</span>
        </template>
        <el-menu-item index="monitor_line">线路监控</el-menu-item>
        <el-menu-item index="monitor_global">全局监测</el-menu-item>
        <el-menu-item index="pantograph_archive">受电弓档案</el-menu-item>
        <el-menu-item index="fault_overview">实时告警</el-menu-item>
      </el-sub-menu>

      <el-sub-menu index="g-train">
        <template #title>
          <el-icon><Van /></el-icon>
          <span>智慧列车</span>
        </template>
        <el-menu-item index="train_list">列车总览</el-menu-item>
        <el-menu-item index="train_catenary">弓网状态</el-menu-item>
        <el-menu-item index="carbon_strip">碳滑板状态</el-menu-item>
      </el-sub-menu>

      <el-sub-menu index="g-maint">
        <template #title>
          <el-icon><Tools /></el-icon>
          <span>智慧检修</span>
        </template>
        <el-menu-item index="ops_center">运维中心</el-menu-item>
        <el-menu-item index="replacement_ledger">换板台账</el-menu-item>
        <el-menu-item index="maintenance_plan">检修计划</el-menu-item>
      </el-sub-menu>

      <el-sub-menu index="g-analysis">
        <template #title>
          <el-icon><DataAnalysis /></el-icon>
          <span>智慧分析</span>
        </template>
        <el-menu-item index="fault_analysis">故障分析</el-menu-item>
        <el-menu-item index="wear_forecast">磨耗预测</el-menu-item>
        <el-menu-item index="health_assessment">健康度评估</el-menu-item>
        <el-menu-item index="report">报表中心</el-menu-item>
      </el-sub-menu>

      <el-sub-menu index="g-system">
        <template #title>
          <el-icon><Setting /></el-icon>
          <span>系统</span>
        </template>
        <el-menu-item index="monitor_car">控制台</el-menu-item>
        <el-menu-item index="box_alarm_monitor">黑盒告警</el-menu-item>
      </el-sub-menu>
    </el-menu>
  </div>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import {
  Odometer, Van, Tools, DataAnalysis, Setting,
} from '@element-plus/icons-vue'

const router = useRouter()
const route = useRoute()

// 菜单 key → 路由 name（一一对应，不再多个 key 指向同一页）
const MENU_ROUTE_NAME = {
  monitor_global: 'MonitorGlobal',
  monitor_line: 'MonitorLine',
  pantograph_archive: 'PantographArchive',
  fault_overview: 'FaultOverview',
  train_list: 'TrainList',
  train_catenary: 'TrainCatenary',
  carbon_strip: 'CarbonStripDetail',
  ops_center: 'OpsCenter',
  replacement_ledger: 'ReplacementLedger',
  maintenance_plan: 'MaintenancePlan',
  fault_analysis: 'FaultAnalysis',
  wear_forecast: 'WearForecast',
  health_assessment: 'HealthAssessment',
  report: 'Reports',
  monitor_car: 'MonitorCar',
  box_alarm_monitor: 'BoxAlarmMonitor',
}

// 路由 name → 菜单 key（用于高亮）
const ROUTE_TO_MENU = Object.fromEntries(
  Object.entries(MENU_ROUTE_NAME).map(([menu, name]) => [name, menu]),
)
ROUTE_TO_MENU.LinePantograph = 'pantograph_archive'

// 菜单 key → 所属分组（用于自动展开当前分组）
const MENU_GROUP = {
  monitor_global: 'g-monitor', monitor_line: 'g-monitor',
  pantograph_archive: 'g-monitor', fault_overview: 'g-monitor',
  train_list: 'g-train', train_catenary: 'g-train', carbon_strip: 'g-train',
  ops_center: 'g-maint', replacement_ledger: 'g-maint', maintenance_plan: 'g-maint',
  fault_analysis: 'g-analysis', wear_forecast: 'g-analysis',
  health_assessment: 'g-analysis', report: 'g-analysis',
  monitor_car: 'g-system', box_alarm_monitor: 'g-system',
}

const activeKey = ref('monitor_line')

// 默认只展开当前页所在分组，避免 16 个二级项把侧栏撑满
const openedGroups = computed(() => {
  const g = MENU_GROUP[activeKey.value]
  return g ? [g] : ['g-monitor']
})

const handleMenuSelect = (key) => {
  activeKey.value = key
  router.push({ name: MENU_ROUTE_NAME[key] || key })
}

watch(
  () => route.name,
  (name) => {
    if (ROUTE_TO_MENU[name]) activeKey.value = ROUTE_TO_MENU[name]
  },
  { immediate: true },
)
</script>

<style scoped>
.menu {
  height: 100vh;
  overflow-y: auto;
  scrollbar-width: none;
  padding-top: 4px;
}
.menu::-webkit-scrollbar {
  display: none;
}
:deep(.el-menu) {
  border-right: none;
}
:deep(.el-sub-menu__title) {
  margin: 2px 8px;
  border-radius: 10px;
  height: 42px;
  line-height: 42px;
  font-size: 14px;
}
:deep(.el-sub-menu__title:hover) {
  background: rgba(0, 198, 255, 0.1) !important;
}
:deep(.el-menu-item) {
  margin: 2px 8px 2px 14px;
  border-radius: 8px;
  height: 36px;
  line-height: 36px;
  font-size: 13px;
  min-width: 0;
}
:deep(.el-menu-item:hover) {
  background: rgba(0, 198, 255, 0.12) !important;
}
:deep(.el-menu-item.is-active) {
  background: rgba(0, 198, 255, 0.18) !important;
  color: #00c6ff !important;
}
:deep(.el-sub-menu .el-menu-item) {
  padding-left: 42px !important;
}
:deep(.el-icon) {
  margin-right: 6px;
}
</style>
