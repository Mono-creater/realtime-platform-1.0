<!-- 受电弓详情-右侧碳滑板信息 -->
<template>
  <div class="carbonInfo">
    <!-- 基本信息展示区 -->
    <div class="basic-info">
      <div class="basic-info-title">基本信息</div>
      <div class="basic-info-row">
        <span>碳滑板编号：THB000001</span>
        <span>类型：纵型</span>
        <span>宽度：60mm</span>
        <span>维修周期：一个月</span>
        <span>下一次定期维修：2025-1-25</span>
      </div>
    </div>
<!-- 故障预警区 -->
<div class="warning-carousel">
  <div class="warning-title">故障预警</div>
  <!-- 有数据时渲染滚动板 -->
  <dv-scroll-board
    v-if="warningList.length > 0"
    @click="handleClick"
    :config="warningScrollConfig"
    :style="{ height: warningBoardHeight, width: '100%' }"
  />
  <!-- 无数据时显示提示 -->
  <div v-else class="empty-warning">暂无预警数据</div>
</div>
    <!-- 弓网关系超限卡片区（点击卡片触发弹窗） -->
    <div class="over-limit-cards">
      <div
        class="over-limit-card"
        v-for="(card, idx) in overLimitCards"
        :key="card.title"
        @click="openModal(card.title)"
      >
        <img :src="overImgs[idx]" class="over-limit-bg" />
        <div class="over-limit-content">
          <div class="over-limit-title">{{ card.title }}</div>
          <div class="over-limit-count">
            <span class="over-limit-num">{{ card.count }}</span
            >次
          </div>
        </div>
      </div>
    </div>

    <!-- 碳滑板自身告警（3.0：不再只有弓网关系） -->
    <div class="carbon-alarm-row">
      <div class="carbon-alarm-label">碳滑板自身</div>
      <div
        class="carbon-alarm-chip"
        v-for="card in carbonCards"
        :key="card.title"
        :class="{ empty: !card.count }"
        @click="card.count && openModal(card.title)"
      >
        <span class="chip-title">{{ card.title }}</span>
        <span class="chip-count">{{ card.count }}</span>
      </div>
    </div>

    <!-- ====== 新增：超限详情弹窗 ====== -->
    <div v-if="modalVisible" class="modal-overlay" @click.self="closeModal">
      <div class="modal-container">
        <div class="modal-header">
          <span class="modal-title">{{ selectedType }} · 故障车次列表</span>
          <span class="modal-badge">{{ filteredList.length }} 条</span>
          <button class="modal-close" @click="closeModal">✕</button>
        </div>
        <div class="modal-body">
          <!-- 无数据 -->
          <div v-if="filteredList.length === 0" class="empty-state">
            暂无该类型故障记录
          </div>
          <!-- 表格 -->
          <div v-else class="table-wrapper">
            <table class="modal-table">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>碳滑板编号</th>
                  <th>预警内容</th>
                  <th>预警时间</th>
                  <th>维修人工号</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(item, index) in filteredList"
                  :key="item.id"
                  :class="index % 2 === 0 ? 'even-row' : 'odd-row'"
                >
                  <td>{{ index + 1 }}</td>
                  <td>{{ item.code }}</td>
                  <td>{{ item.content }}</td>
                  <td>{{ item.time }}</td>
                  <td>{{ item.worker }}</td>
                  <td>{{ item.remark === '/' ? '—' : item.remark }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useAlarmStore } from '@/stores/alarms'
import { CATENARY_ALARM_TYPES, CARBON_STRIP_ALARM_TYPES, filterPantographAlarms, countByContent } from '@/utils/alarm-types'
import over1 from '@/assets/images/over12.png'
import over2 from '@/assets/images/over22.png'
import over3 from '@/assets/images/over33.png'
import over4 from '@/assets/images/over44.png'

const router = useRouter()
const overImgs = [over1, over2, over3, over4]

// 全站共享列表：受电弓详情页只消费其中的部件告警
const store = useAlarmStore()
const { list: allWarnings } = storeToRefs(store)

// ---------- 实时数据（初始空，等待后端推送） ----------
const warningList = ref([])                  // 预警列表（受电弓部件告警 = 弓网 + 碳滑板）
const overLimitCards = ref(CATENARY_ALARM_TYPES.map(title => ({ title, count: 0 })))
const carbonCards = ref(CARBON_STRIP_ALARM_TYPES.map(title => ({ title, count: 0 })))

// ---------- 公共更新函数 ----------
/**
 * 预警列表内容签名：用于"内容未变则不重建数据"。
 *
 * 必要性：后端在模拟/采集模式下会周期性广播 fullUpdate（约 2 s 一次），
 * 若每次都把 warningList 换成新数组，warningScrollConfig 这个 computed 就会
 * 反复产出新对象，触发 dv-scroll-board 的 config 深度 watcher；
 * 而该组件启动轮播时会先 await waitTime(2 s) 再校验 updater，
 * 途中一旦配置变更即直接 return，导致【轮播动画永远无法启动】。
 * 因此这里按内容签名去重，只有告警内容真正变化时才重建滚动板配置。
 */
function warningSignature(list) {
  return list
    .map(i => `${i.id}|${i.code}|${i.content}|${i.time}|${i.worker}|${i.remark}`)
    .join('#')
}
let lastWarningSig = ''

function updateWarningData(newList) {
  // 受电弓详情页只展示受电弓部件告警：高温/低温/高湿等环境因素引起的预警，
  // 以及反映气路状态的高压/低压报警，均不代表碳滑板自身故障，在此过滤掉，
  // 避免与下方四张超限卡片（只统计部件告警）口径矛盾。
  const list = filterPantographAlarms(newList).map(w => ({
    ...w,
    time: fmtTime(w.timeFull || w.time),
  }))
  const sig = warningSignature(list)
  if (sig === lastWarningSig) return      // 内容未变 → 不触发滚动板配置重建
  lastWarningSig = sig
  warningList.value = list
  // 重新计算卡片计数
  const counts = countByContent(list)
  overLimitCards.value = CATENARY_ALARM_TYPES.map(title => ({
    title,
    count: counts[title] || 0,
  }))
  carbonCards.value = CARBON_STRIP_ALARM_TYPES.map(title => ({
    title,
    count: counts[title] || 0,
  }))
}

// 本地时间格式化：store 里的 time 可能是完整 ISO（含时分秒与 Z），直接展示会很难读
function fmtTime(v) {
  const d = new Date(v)
  if (!Number.isFinite(d.getTime())) return v || ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ---------- 动态滚动板配置（依赖 warningList） ----------
// 固定显示行数上限（数据不足时按实际条数收窄，避免空白行）
const BASE_ROW_NUM = 5
// 行高：与"容器 220px − 表头 36px，5 行"时的行高一致，保证行高不随行数跳变
const BOARD_ROW_HEIGHT = (220 - 36) / 5

const warningScrollConfig = computed(() => {
  const base = warningList.value.map((item, index) => [
    index + 1,        // ✅ 序号从 1 开始连续编号
    item.code,
    item.content,
    item.time,
    item.worker,
    item.remark,
  ])

  // dv-scroll-board 仅在 data.length > rowNum 时才启动轮播（源码守卫 `rowNum >= rowsData.length` 即返回）。
  // 数据恰好铺满一屏（或不足一屏）时补足行数，保证"循环滚动"始终可见。
  const rowNum = Math.min(BASE_ROW_NUM, Math.max(1, base.length))
  let data = base
  while (data.length > 0 && data.length <= rowNum) data = data.concat(base)

  return {
    header: ['序号', '碳滑板编号', '预警内容', '预警时间', '维修人工号', '备注'],
    data,
    rowNum,
    // 显式声明轮播参数（库默认值虽相同，显式声明可避免版本升级后默认值变化导致不滚动）
    carousel: 'single',       // 'single' = 逐行滚动；'page' = 整页翻动
    waitTime: 2000,           // 每步停留 2 s
    hoverPause: true,         // 鼠标悬停暂停
    headerBGC: '#0a2e5d',
    oddRowBGC: 'rgba(10,46,93,0.3)',
    evenRowBGC: 'rgba(10,46,93,0.1)',
    align: ['center', 'center', 'center', 'center', 'center', 'center'],
    headerHeight: 36,
    index: false,
  }
})

// 滚动板高度随显示行数自适应，避免行数收窄后底部留白
const warningBoardHeight = computed(() => {
  const rowNum = Math.min(BASE_ROW_NUM, Math.max(1, warningList.value.length))
  return `${Math.round(36 + rowNum * BOARD_ROW_HEIGHT)}px`
})
// ---------- 弹窗相关 ----------
const modalVisible = ref(false)
const selectedType = ref('')

// 根据选中的超限类型过滤预警列表
const filteredList = computed(() => {
  if (!selectedType.value) return []
  const list = Array.isArray(warningList.value) ? warningList.value : []
  return list.filter((item) => item.content === selectedType.value)
})

// 打开弹窗
function openModal(type) {
  selectedType.value = type
  modalVisible.value = true
}

// 关闭弹窗
function closeModal() {
  modalVisible.value = false
  // 可选：延迟重置类型，避免关闭时列表闪烁
  setTimeout(() => {
    selectedType.value = ''
  }, 200)
}

// ---------- 点击滚动板：跳转到数据驱动的告警详情页 ----------
function handleClick(e) {
  const row = e && Array.isArray(e.row) ? e.row : []
  const found = row[1] ? warningList.value.find(w => w.code === row[1]) : null
  router.push({
    name: 'PantographWarning',
    query: { id: found ? found.id : undefined },
  })
}

// ---------- 生命周期 ----------
onMounted(() => {
  store.bind()
})

// 列表变化（首屏加载 / WS 增量）统一走过滤 + 签名去重，保证滚动板不重建
watch(allWarnings, (v) => updateWarningData(v || []), { immediate: true })
</script>

<style scoped>
/* ===== 原有样式（保持不变） ===== */
.empty-warning {
  color: #a0b8d0;
  text-align: center;
  padding: 40px 0;
  font-size: 16px;
  background: rgba(10,46,93,0.2);
  border-radius: 8px;
}
.carbonInfo {
  flex: 1;
  height: 100%;
  background: rgba(10, 46, 93, 0.4);
  border-radius: 5px;
  box-sizing: border-box;
}
.basic-info {
  border-radius: 8px 8px 0 0;
  padding: 12px 24px 8px 24px;
  margin-bottom: 8px;
}
.basic-info-title {
  color: #fff;
  font-size: 20px;
  font-weight: bold;
  margin-bottom: 6px;
  border-left: 6px solid #7be5e5;
  padding-left: 10px;
}
.basic-info-row {
  color: #fff;
  font-size: 15px;
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  margin-bottom: 2px;
}
.warning-carousel {
  padding: 10px 24px 8px 24px;
  margin-bottom: 8px;
}
.warning-title {
  color: #fff;
  font-size: 18px;
  font-weight: bold;
  margin-bottom: 6px;
  border-left: 6px solid #7be5e5;
  padding-left: 10px;
}
.over-limit-cards {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-top: 16px;
  gap: 18px;
  padding: 0 20px;
}
.over-limit-card {
  flex: 1;
  max-width: 150px;
  min-height: 180px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  padding: 10px;
  cursor: pointer; /* 增加手型指针 */
  transition: transform 0.15s ease;
}
.over-limit-card:hover {
  transform: scale(1.03);
}
.over-limit-card:active {
  transform: scale(0.97);
}
.over-limit-bg {
  width: 100%;
  height: 180px;
  object-fit: contain;
  border-radius: 12px;
  display: block;
}
.over-limit-content {
  position: absolute;
  top: -15px;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 2;
}
.over-limit-title {
  color: #fff;
  font-size: 16px;
  text-shadow: 0 2px 8px #000;
}
.over-limit-count {
  color: #fff;
  font-size: 14px;
  font-weight: bold;
  text-shadow: 0 2px 8px #000;
}
.over-limit-num {
  color: #ff3b3b;
  font-size: 20px;
  font-weight: bold;
  margin-right: 2px;
}
/* 碳滑板自身告警：四个紧凑胶囊，与上面四张弓网大卡区分口径 */
.carbon-alarm-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px 0;
  flex-wrap: wrap;
}
.carbon-alarm-label {
  color: #7be5e5;
  font-size: 13px;
  letter-spacing: 1px;
  border-left: 4px solid #7be5e5;
  padding-left: 8px;
  flex-shrink: 0;
}
.carbon-alarm-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-radius: 14px;
  background: rgba(255, 61, 113, 0.12);
  border: 1px solid rgba(255, 61, 113, 0.35);
  cursor: pointer;
  transition: background 0.15s ease;
}
.carbon-alarm-chip:hover {
  background: rgba(255, 61, 113, 0.22);
}
.carbon-alarm-chip.empty {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.1);
  cursor: default;
}
.chip-title {
  color: #e8edf3;
  font-size: 13px;
}
.chip-count {
  color: #ff3b3b;
  font-size: 16px;
  font-weight: 700;
}
.carbon-alarm-chip.empty .chip-count {
  color: #7a8b9f;
}
.warning-carousel :deep(.dv-scroll-board .rows .row-item:hover) {
  color: #fff;
  cursor: pointer;
  font-size: 15px !important;
}

/* ===== 新增：弹窗样式 ===== */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 9999;
  padding: 20px;
  animation: fadeIn 0.2s ease;
}
.modal-container {
  background: #1a2f4a; /* 深色背景，与整体风格匹配 */
  border-radius: 16px;
  max-width: 900px;
  width: 100%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  animation: slideUp 0.25s ease;
  border: 1px solid rgba(123, 229, 229, 0.2);
}
.modal-header {
  display: flex;
  align-items: center;
  padding: 18px 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-wrap: wrap;
  gap: 12px;
}
.modal-title {
  font-size: 20px;
  font-weight: 600;
  color: #fff;
  flex: 1;
}
.modal-badge {
  background: rgba(123, 229, 229, 0.2);
  color: #7be5e5;
  padding: 2px 14px;
  border-radius: 20px;
  font-size: 14px;
  font-weight: 500;
}
.modal-close {
  background: transparent;
  border: none;
  color: #a0b8d0;
  font-size: 24px;
  cursor: pointer;
  padding: 0 6px;
  transition: color 0.15s;
}
.modal-close:hover {
  color: #fff;
}
.modal-body {
  padding: 20px 24px 24px;
  overflow-y: auto;
  flex: 1;
}
.empty-state {
  color: #a0b8d0;
  text-align: center;
  padding: 40px 0;
  font-size: 16px;
}
.table-wrapper {
  overflow-x: auto;
  max-height: 400px;
  overflow-y: auto;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.modal-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  color: #e8edf3;
}
.modal-table thead th {
  background: #0a2e5d; /* 与 headerBGC 一致 */
  color: #fff;
  padding: 0 12px;
  height: 36px; /* headerHeight */
  text-align: center;
  font-weight: 600;
  position: sticky;
  top: 0;
  z-index: 2;
  white-space: nowrap;
}
.modal-table tbody td {
  padding: 0 12px;
  height: 32px; /* rowHeight */
  text-align: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.modal-table tbody .odd-row {
  background: rgba(10, 46, 93, 0.3); /* oddRowBGC */
}
.modal-table tbody .even-row {
  background: rgba(10, 46, 93, 0.1); /* evenRowBGC */
}
.modal-table tbody tr:hover {
  background: rgba(123, 229, 229, 0.1);
}

/* ===== 动画 ===== */
@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* ===== 响应式微调 ===== */
@media (max-width: 700px) {
  .modal-container {
    max-width: 100%;
    margin: 12px;
    border-radius: 12px;
  }
  .modal-header {
    padding: 14px 16px;
  }
  .modal-body {
    padding: 12px 16px 16px;
  }
  .modal-table {
    font-size: 13px;
  }
  .modal-table thead th,
  .modal-table tbody td {
    padding: 0 6px;
  }
}
</style>


