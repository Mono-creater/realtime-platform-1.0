<template>
  <!-- 线路监控模块下的组件：三张表全部取自 /api/history 与 /api/stats/summary -->
  <div class="tabls">
    <!-- 最新告警列表（受电弓部件告警） -->
    <div class="table-section1">
      <div class="table-title">
        <div class="info">最新告警列表</div>
        <div class="state">
          <div class="item">
            <input type="checkbox" checked disabled />
            <span>部件告警 {{ alarmConfig.data.length }} 条</span>
          </div>
        </div>
      </div>
      <template v-if="alarmConfig.data.length > 0">
        <dv-scroll-board @click="handleAlarmRowClick" :config="alarmConfig" style="height: 220px" />
      </template>
      <div v-else class="empty-tip">暂无部件告警，碳滑板状态正常</div>
    </div>

    <!-- 最新预警列表（环境/气路通道） -->
    <div class="table-section2">
      <div class="table-title">
        <div class="info">最新预警列表</div>
        <div class="state"></div>
      </div>
      <template v-if="warnConfig.data.length > 0">
        <dv-scroll-board :config="warnConfig" style="height: 220px" />
      </template>
      <div v-else class="empty-tip">最近无环境/气路预警</div>
    </div>

    <!-- 受电弓运行状态总览 -->
    <div class="table-section3">
      <div class="table-title">
        <div class="info">受电弓状态总览</div>
        <div class="state">
          <div class="item">
            <img style="margin-right: 3px" src="@/assets/icons/greenCircle.png" width="8" alt="" />
            <span>正常</span>
          </div>
          <div class="item">
            <img style="margin-right: 3px" src="@/assets/icons/redCircle.png" width="8" alt="" />
            <span>告警</span>
          </div>
        </div>
      </div>
      <dv-scroll-board :config="statusConfig" style="height: 220px" />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useAlarmStore } from '@/stores/alarms'
import { PANTOGRAPH_ALARM_TYPES, ENV_ALARM_TYPES } from '@/utils/alarm-types'
import greenCircle from '@/assets/icons/greenCircle.png'
import redCircle from '@/assets/icons/redCircle.png'

const router = useRouter()

// 全站共享的告警列表与聚合统计（由 Pinia store 统一拉取 + WS 增量维护）
const store = useAlarmStore()
const { list: allWarnings, summary } = storeToRefs(store)

const BASE_CONFIG = {
  rowNum: 5,
  headerBGC: '#0a2e5d',
  oddRowBGC: 'rgba(10,46,93,0.3)',
  evenRowBGC: 'rgba(10,46,93,0.1)',
  align: ['center'],
  headerHeight: 36,
  index: false,
  carousel: 'single',
  waitTime: 2500,
  hoverPause: true,
}

function fmtTime(v) {
  const d = new Date(v)
  if (isNaN(d.getTime())) return '--'
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 行数不足一屏时补足，保证 dv-scroll-board 的轮播前置条件（data.length > rowNum） */
function padRows(rows, rowNum = 5) {
  if (rows.length === 0) return rows
  let out = rows
  while (out.length <= rowNum) out = out.concat(rows)
  return out
}

const alarmConfig = computed(() => {
  const rows = allWarnings.value
    .filter(w => PANTOGRAPH_ALARM_TYPES.includes(w.content))
    .slice(0, 30)
    .map(w => [w.code || '--', w.content, w.worker || '--', fmtTime(w.timeFull || w.time)])
  return Object.assign({}, BASE_CONFIG, {
    header: ['编号', '告警内容', '工号', '时间'],
    data: padRows(rows),
    rowNum: Math.min(5, Math.max(1, rows.length)),
    align: ['center', 'center', 'center', 'center'],
  })
})

const warnConfig = computed(() => {
  const rows = allWarnings.value
    .filter(w => ENV_ALARM_TYPES.includes(w.content))
    .slice(0, 30)
    .map(w => [w.code || '--', w.content, fmtTime(w.timeFull || w.time)])
  return Object.assign({}, BASE_CONFIG, {
    header: ['编号', '预警内容', '时间'],
    data: padRows(rows),
    rowNum: Math.min(5, Math.max(1, rows.length)),
    align: ['center', 'center', 'center'],
  })
})

// 按受电弓编号聚合：状态取最近一条告警类型，健康度为平台整体口径
const statusConfig = computed(() => {
  const map = new Map()
  for (const w of allWarnings.value) {
    const code = w.code || '--'
    if (!map.has(code)) {
      map.set(code, { code, count: 0, last: 0, lastContent: '', line: '--' })
    }
    const e = map.get(code)
    e.count += 1
    const t = new Date(w.timeFull || w.time).getTime()
    if (Number.isFinite(t) && t >= e.last) {
      e.last = t
      e.lastContent = w.content
    }
    if (w.line && w.line !== '--') e.line = w.line
  }
  const health = summary.value.health
  const rows = [...map.values()]
    .sort((a, b) => b.last - a.last)
    .slice(0, 30)
    .map(e => {
      const hasAlarm = PANTOGRAPH_ALARM_TYPES.includes(e.lastContent)
      const icon = hasAlarm ? redCircle : greenCircle
      return [
        `<img src="${icon}" style="width:8px;vertical-align:middle;margin-right:4px" />${e.code}`,
        e.line,
        hasAlarm ? e.lastContent : '正常',
        String(e.count),
        e.last ? fmtTime(new Date(e.last)) : '--',
        health === undefined ? '--' : `${health}%`,
      ]
    })
  return Object.assign({}, BASE_CONFIG, {
    header: ['编号', '线路', '状态', '告警数', '最近上报', '健康度'],
    data: padRows(rows),
    rowNum: Math.min(5, Math.max(1, rows.length)),
    align: ['center', 'center', 'center', 'center', 'center', 'center'],
  })
})

// 点击告警行 → 受电弓详情页（原交互：先看整弓状态与故障预警列表，再从列表进告警详情）
function handleAlarmRowClick(e) {
  router.push({ name: 'LinePantograph', params: { id: e && e.rowIndex } })
}

onMounted(() => {
  store.bind()
})
</script>

<style scoped>
.tabls {
  display: flex;
  justify-content: space-between;
  margin-top: 10px;
}
.table-section1 {
  width: 30%;
  background: rgba(10, 46, 93, 0.5);
  border-radius: 5px;
  padding: 10px;
  margin: 0 5px;
  min-width: 0;
}
.table-section2 {
  width: 25%;
  background: rgba(10, 46, 93, 0.5);
  border-radius: 5px;
  padding: 10px;
  margin: 0 5px;
  min-width: 0;
}
.table-section3 {
  flex: 1;
  background: rgba(10, 46, 93, 0.5);
  border-radius: 5px;
  padding: 10px;
  margin: 0 5px;
  min-width: 0;
}
.table-title {
  color: #00eaff;
  font-size: 18px;
  font-weight: bold;
  margin-bottom: 5px;
  text-align: center;
  padding: 8px 0;
  border-radius: 5px;
  background: linear-gradient(90deg, #0a2e5d 0%, #00eaff 100%);
  letter-spacing: 2px;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 30px;
}
.table-title .state {
  display: flex;
  font-size: 12px;
  justify-self: flex-end;
  gap: 5px;
}
.table-section1 .table-title {
  background: linear-gradient(90deg, #310b0c 0%, #ec3329 100%);
  color: #eb3222;
}
.table-section2 .table-title {
  background: linear-gradient(90deg, #515d0a 0%, #ffe066 100%);
  color: #ffe066;
}
.table-section3 .table-title {
  background: linear-gradient(90deg, #0a2e5d 0%, #3be6c1 100%);
  color: #3be6c1;
}
.empty-tip {
  height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 12px;
  opacity: 0.7;
}
:deep(.dv-scroll-board .header) {
  font-size: 12px !important;
  color: #56c9f3;
  font-weight: 500;
}
:deep(.dv-scroll-board .rows .row-item) {
  font-size: 10px !important;
}
.table-section1 :deep(.dv-scroll-board .rows .row-item) {
  color: rgb(246, 85, 85);
}
.table-section1 :deep(.dv-scroll-board .rows .row-item:hover) {
  color: rgb(149, 12, 12);
  filter: brightness(2);
  cursor: pointer;
  font-size: 11px !important;
}
</style>
