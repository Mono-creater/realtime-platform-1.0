<template>
  <div class="fault-overview">
    <!-- 标题与搜索栏 -->
    <div class="overview-header">
      <span class="title">📋 实时故障总览</span>
      <div class="header-actions">
        <el-input
          v-model="keyword"
          placeholder="搜索车号/内容/编号..."
          clearable
          prefix-icon="Search"
          size="default"
          class="search-input"
        />
        <el-button
          type="danger"
          plain
          size="default"
          :disabled="selectedRows.length === 0"
          @click="deleteSelected"
        >
          🗑️ 删除选中记录{{ selectedRows.length ? `（${selectedRows.length}）` : '' }}
        </el-button>
      </div>
    </div>

    <!-- 滚动表格容器 -->
    <div class="scroll-wrapper" ref="scrollWrapper">
      <el-table
        ref="tableRef"
        :data="filteredData"
        border
        max-height="100%"
        row-key="id"
        class="scroll-table"
        style="width: 100%;"
        @row-click="handleRowClick"
        @selection-change="handleSelectionChange"
        :row-class-name="rowClassName"
      >
        <el-table-column type="selection" width="48" align="center" />
        <el-table-column label="序号" type="index" width="60" align="center" />
        <el-table-column prop="code" label="碳滑板编号" min-width="120" align="center" />
        <el-table-column prop="content" label="预警内容" min-width="100" align="center" />
        <el-table-column prop="time" label="预警时间" min-width="110" align="center" />
        <el-table-column prop="worker" label="维修人工号" min-width="110" align="center" />
        <el-table-column label="受电弓档案" min-width="280" align="left">
          <template #default="{ row }">
            <span v-if="row.context" class="panto-context">{{ row.context }}</span>
            <span v-else style="color:#7a8b9f">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="200" align="center">
          <template #default="{ row }">
            {{ displayRemark(row) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" align="center" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              type="primary"
              plain
              @click.stop="exportPdf(row)"
            >
              📄 导出PDF
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 空状态（无数据或搜索无结果） -->
      <div v-if="filteredData.length === 0" class="empty-placeholder">
        <el-empty
          :description="keyword ? '该车辆无故障记录' : '暂无故障记录'"
          :image-size="80"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import api from '@/utils/api'
import { useAlarmStore } from '@/stores/alarms'

// ---------- 数据 ----------
// 列表来自全站共享 store（不再单独拉 /api/history）
const store = useAlarmStore()
const { list: rawList } = storeToRefs(store)
const keyword = ref('')

function fmtDay(v) {
  const d = new Date(v)
  if (!Number.isFinite(d.getTime())) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const allData = computed(() => rawList.value.map(item => ({
  id: item.id,
  code: item.code,
  content: item.content,
  time: fmtDay(item.timeFull || item.time),
  worker: item.worker || '',
  remark: item.remark || '/',
  context: item.context || '',
})))

const scrollWrapper = ref(null)
const tableRef = ref(null)
let scrollTimer = null
const SCROLL_SPEED = 1.2
const FRAME_INTERVAL = 30

// 选中的行ID（点击高亮）
const selectedRowId = ref(null)

// 勾选删除的记录（多选）
const selectedRows = ref([])
function handleSelectionChange(rows) {
  selectedRows.value = rows
}

// ---------- 环境类预警成因说明 ----------
// 与后端口径一致：高温/低温/高湿属环境因素，非碳滑板部件故障。
// 历史数据的备注可能为空、'/' 或 JSON 调试串，展示时兜底为成因说明
const ENV_FAULT_CAUSES = {
  '高温预警': '环境温度过高所致，属环境因素，非碳滑板部件故障；建议检查环境散热与空调',
  '低温预警': '环境温度过低所致，属环境因素，非碳滑板部件故障；低温下碳条变脆，建议关注取流状态',
  '高湿预警': '环境湿度过高所致，属环境因素，非碳滑板部件故障；高湿易加剧燃弧，建议加强除湿通风'
}
function displayRemark(row) {
  const remark = row.remark || '/'
  if (ENV_FAULT_CAUSES[row.content]) {
    if (remark === '/' || remark.startsWith('{')) {
      return ENV_FAULT_CAUSES[row.content]
    }
    return remark
  }
  return remark === '/' ? '—' : remark
}

// ---------- 过滤 ----------
const filteredData = computed(() => {
  if (!keyword.value.trim()) return allData.value
  const lower = keyword.value.toLowerCase()
  return allData.value.filter(item =>
    item.code?.toLowerCase().includes(lower) ||
    item.content?.toLowerCase().includes(lower) ||
    item.worker?.toLowerCase().includes(lower) ||
    item.time?.includes(keyword.value)
  )
})

// ---------- 获取数据 ----------
async function fetchData() {
  await store.load({ force: true })
  if (store.lastError) {
    ElMessage.error('加载故障数据失败：' + store.lastError)
  }
  tableRef.value?.clearSelection()
  if (scrollWrapper.value) {
    scrollWrapper.value.scrollTop = 0
  }
}

// ---------- 行点击事件 ----------
function handleRowClick(row) {
  // 切换选中状态（点击同一行取消选中，或保持高亮）
  if (selectedRowId.value === row.id) {
    selectedRowId.value = null
  } else {
    selectedRowId.value = row.id
  }
}

// 行类名动态绑定
function rowClassName({ row }) {
  return row.id === selectedRowId.value ? 'selected-row' : ''
}

// ---------- 删除选中故障记录 ----------
async function deleteSelected() {
  if (selectedRows.value.length === 0) return
  try {
    await ElMessageBox.confirm(
      `确定删除选中的 ${selectedRows.value.length} 条故障记录？删除后不可恢复。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return // 用户取消
  }
  try {
    const ids = selectedRows.value.map(r => r.id)
    const res = await api.delete('/api/warnings', { data: { ids } })
    ElMessage.success(`已删除 ${res.data.deleted} 条记录`)
    tableRef.value?.clearSelection()
    await fetchData()
  } catch (err) {
    ElMessage.error('删除失败：' + (err.response?.data?.error || err.message))
    console.error(err)
  }
}

// ---------- 导出指定故障 PDF ----------
function exportPdf(row) {
  const link = document.createElement('a')
  link.href = `/api/export/pdf/${row.id}`
  link.download = `fault-${row.id}.pdf`
  document.body.appendChild(link)
  link.click()
  link.remove()
}

// ---------- 自动滚动 ----------
function startAutoScroll() {
  stopAutoScroll()
  if (filteredData.value.length === 0) return

  scrollTimer = setInterval(() => {
    const container = scrollWrapper.value
    if (!container) return

    const tableBody = container.querySelector('.el-table__body-wrapper')
    if (!tableBody) return

    const maxScroll = tableBody.scrollHeight - tableBody.clientHeight
    if (maxScroll <= 0) return

    let current = tableBody.scrollTop
    let next = current + SCROLL_SPEED

    if (next >= maxScroll) {
      tableBody.scrollTop = 0
    } else {
      tableBody.scrollTop = next
    }
  }, FRAME_INTERVAL)
}

function stopAutoScroll() {
  if (scrollTimer) {
    clearInterval(scrollTimer)
    scrollTimer = null
  }
}

// ---------- 监听过滤变化，重置滚动 ----------
watch(filteredData, () => {
  // 清除选中状态
  selectedRowId.value = null
  nextTick(() => {
    const container = scrollWrapper.value
    if (container) {
      const tableBody = container.querySelector('.el-table__body-wrapper')
      if (tableBody) tableBody.scrollTop = 0
    }
    startAutoScroll()
  })
})

// ---------- 生命周期 ----------
onMounted(async () => {
  store.bind()
  await store.load()
  nextTick(() => {
    startAutoScroll()
  })
})

onBeforeUnmount(() => {
  stopAutoScroll()
})
</script>

<style scoped>
/* ---------- 整体容器 ---------- */
.fault-overview {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: rgba(10, 46, 93, 0.3);
  border-radius: 12px;
  padding: 16px 20px 20px 20px;
  box-sizing: border-box;
  color: #fff;
}

/* ---------- 头部 ---------- */
.overview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  flex-shrink: 0;
}

.overview-header .title {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 1px;
  color: #e0f0ff;
  text-shadow: 0 2px 4px rgba(0,0,0,0.3);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.search-input {
  width: 260px;
}

.search-input :deep(.el-input__wrapper) {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 20px;
  box-shadow: none;
  border: 1px solid rgba(255, 255, 255, 0.15);
}
.search-input :deep(.el-input__wrapper:hover) {
  border-color: rgba(0, 198, 255, 0.6);
}
.search-input :deep(.el-input__inner) {
  color: #fff;
}
.search-input :deep(.el-input__inner::placeholder) {
  color: rgba(255, 255, 255, 0.5);
}
.search-input :deep(.el-input__prefix) {
  color: rgba(255, 255, 255, 0.5);
}

/* ---------- 滚动容器 ---------- */
.scroll-wrapper {
  flex: 1;
  overflow: hidden;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.2);
  position: relative;
}

.scroll-table {
  height: 100%;
  background: transparent;
}

/* 表格头样式 */
.scroll-table :deep(.el-table__header-wrapper) {
  background: #0a2e5d !important;
}
.scroll-table :deep(.el-table__header-wrapper th) {
  background: #0a2e5d !important;
  color: #fff !important;
  font-weight: 600;
}

/* 表格体滚动 */
.scroll-table :deep(.el-table__body-wrapper) {
  overflow-y: auto !important;
  scroll-behavior: smooth;
}
.scroll-table :deep(.el-table__body-wrapper::-webkit-scrollbar) {
  width: 4px;
}
.scroll-table :deep(.el-table__body-wrapper::-webkit-scrollbar-track) {
  background: transparent;
}
.scroll-table :deep(.el-table__body-wrapper::-webkit-scrollbar-thumb) {
  background: rgba(123, 229, 229, 0.5);
  border-radius: 10px;
}

/* 行样式：无条纹，统一背景 */
.scroll-table :deep(.el-table__row) {
  background: rgba(255, 255, 255, 0.04) !important;
  color: #e8edf3;
  transition: all 0.2s ease;
}

/* 悬停效果 */
.scroll-table :deep(.el-table__row:hover) {
  background: rgba(123, 229, 229, 0.1) !important;
}

/* ---------- 选中行：边框泛光效果 ---------- */
.scroll-table :deep(.el-table__row.selected-row) {
  background: rgba(0, 198, 255, 0.08) !important;
  box-shadow: inset 0 0 0 2px #00c6ff, 0 0 20px rgba(0, 198, 255, 0.4) !important;
  border-radius: 4px; /* 使边框圆角 */
  transition: box-shadow 0.3s, background 0.3s;
}

/* 点击反馈：瞬间缩放效果（通过行内元素的伪类或过渡） */
.scroll-table :deep(.el-table__row:active) {
  transform: scale(0.99);
  transition: transform 0.1s;
}

/* 边框透明 */
.scroll-table :deep(.el-table__inner-wrapper) {
  border: none;
}
.scroll-table :deep(.el-table__body) {
  border: none;
}
.scroll-table :deep(.el-table__border-left-patch) {
  display: none;
}
.scroll-table :deep(.el-table__border-right-patch) {
  display: none;
}

/* ---------- 空状态 ---------- */
.empty-placeholder {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 100%;
  text-align: center;
  pointer-events: none;
}

/* 受电弓档案上下文（3.0：告警不只报"通道超限"） */
.panto-context {
  color: #7ee0d8;
  font-size: 13px;
  line-height: 1.5;
  display: inline-block;
}
</style>