import { createRouter, createWebHistory } from 'vue-router'
import Index from '@/views/index.vue'
import MonitorGlobal from '@/views/SmartDetection/MonitorGlobal.vue'
import MonitorLine from '@/views/SmartDetection/MonitorLine.vue'
import MonitorCar from '@/views/SmartDetection/MonitorCar.vue'
import OpsCenter from '@/views/SmartDetection/OpsCenter.vue'
import BoxAlarmMonitor from '@/views/SmartDetection/BoxAlarmMonitor.vue'
import FaultOverview from '@/views/SmartDetection/FaultOverview.vue'
import Line_Pantograph from '@/views/SmartDetection/Line_Pantograph2.vue'
import PantographWarning from '@/views/SmartDetection/PantographWarning.vue'
import PantographArchive from '@/views/SmartDetection/PantographArchive.vue'
import CarbonStripDetail from '@/views/SmartDetection/CarbonStripDetail.vue'
import Reports from '@/views/SmartDetection/Reports.vue'
// 3.0 四域菜单新增页（每个二级项一个独立页面，避免"四个入口内容一样"）
import TrainList from '@/views/SmartDetection/TrainList.vue'
import TrainCatenary from '@/views/SmartDetection/TrainCatenary.vue'
import ReplacementLedger from '@/views/SmartDetection/ReplacementLedger.vue'
import MaintenancePlan from '@/views/SmartDetection/MaintenancePlan.vue'
import FaultAnalysis from '@/views/SmartDetection/FaultAnalysis.vue'
import WearForecast from '@/views/SmartDetection/WearForecast.vue'
import HealthAssessment from '@/views/SmartDetection/HealthAssessment.vue'
import Login from '@/views/Login.vue'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: Login,
      meta: { public: true },
    },
    {
      path: '/',
      name: 'Index',
      component: Index,
      // 打开网址默认进入"线路监控"
      redirect: 'monitor_line',
      children: [
        {
          // 根路径统一跳到线路监控，保证地址栏与页面一致
          path: '',
          redirect: { name: 'MonitorLine' },
        },
        {
          path: 'monitor_global',
          name: 'MonitorGlobal',
          component: MonitorGlobal,
        },
        {
          path: 'monitor_line',
          name: 'MonitorLine',
          component: MonitorLine,
        },
        {
          path: 'monitor_car',
          name: 'MonitorCar',
          component: MonitorCar,
        },
        {
          path: 'fault_overview',
          name: 'FaultOverview',
          component: FaultOverview,
        },
        {
          path: 'ops_center',
          name: 'OpsCenter',
          component: OpsCenter,
        },
        {
          // 黑盒子（图传）上传告警：纯 HTTP 轮询，与 WebSocket 链路互不影响
          path: 'box_alarm_monitor',
          name: 'BoxAlarmMonitor',
          component: BoxAlarmMonitor,
        },
        {
          // 一弓一档：受电弓档案 + 3 域健康度 + 全生命周期时间轴
          path: 'pantograph_archive',
          name: 'PantographArchive',
          component: PantographArchive,
        },
        {
          // 滑板详情：四测点厚度 / 磨耗趋势 / 缺陷图 / 换板记录
          path: 'carbon_strip',
          name: 'CarbonStripDetail',
          component: CarbonStripDetail,
        },
        {
          // 报表中心：健康度统计 + 趋势 + 导出
          path: 'report',
          name: 'Reports',
          component: Reports,
        },
        // ---- 智慧列车 ----
        {
          // 列车总览：车队列表（车号/线路/弓位/里程/滑板/健康度）
          path: 'train_list',
          name: 'TrainList',
          component: TrainList,
        },
        {
          // 弓网状态：单车弓网指标（接触力/导高/拉出值/燃弧）
          path: 'train_catenary',
          name: 'TrainCatenary',
          component: TrainCatenary,
        },
        // ---- 智慧检修 ----
        {
          // 换板台账：全车队换板记录
          path: 'replacement_ledger',
          name: 'ReplacementLedger',
          component: ReplacementLedger,
        },
        {
          // 检修计划：按剩余厚度 / 剩余寿命 / 健康度排序
          path: 'maintenance_plan',
          name: 'MaintenancePlan',
          component: MaintenancePlan,
        },
        // ---- 智慧分析 ----
        {
          // 故障分析：Pareto + 趋势 + 类型构成
          path: 'fault_analysis',
          name: 'FaultAnalysis',
          component: FaultAnalysis,
        },
        {
          // 磨耗预测：车队磨耗速率排名 + RUL 外推
          path: 'wear_forecast',
          name: 'WearForecast',
          component: WearForecast,
        },
        {
          // 健康度评估：3 域健康度排名与分级
          path: 'health_assessment',
          name: 'HealthAssessment',
          component: HealthAssessment,
        },
      ],
    },
    // 受电弓详情（旧入口，保留兼容）
    {
      path: '/moterline_pantograph',
      name: 'LinePantograph',
      component: Line_Pantograph,
    },
    // 告警详情（数据驱动页；旧路由重定向兼容，透传 query）
    {
      path: '/pantograph-warning',
      name: 'PantographWarning',
      component: PantographWarning,
    },
    {
      path: '/moterline_pantograph_warning',
      name: 'LinePantographWarning',
      redirect: (to) => ({ name: 'PantographWarning', query: to.query }),
    },
  ],
})

// 路由守卫：仅在服务端启用认证（AUTH_ENABLED=true）时生效；未启用时全部放行
router.beforeEach(async (to) => {
  if (to.meta && to.meta.public) return true
  const auth = useAuthStore()
  if (!auth.checked) await auth.fetchMe()
  if (auth.enabled && !auth.user) {
    return { name: 'Login', query: { redirect: to.fullPath } }
  }
  return true
})

export default router
