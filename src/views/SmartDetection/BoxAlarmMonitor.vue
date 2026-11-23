<template>
  <div class="box-alarm-monitor">
    <!-- 标题栏 -->
    <div class="overview-header">
      <span class="title">🛰️ 黑盒子上传告警实时监控</span>
      <div class="header-actions">
        <span class="poll-status" :class="{ 'poll-status--err': pollError }">
          <span class="poll-dot"></span>
          {{ pollError ? ('轮询异常' + (pollErrorMsg ? '：' + pollErrorMsg : '')) : `HTTP 轮询中 · 300ms · 共 ${allData.length} 条` }}
        </span>
        <el-button
          v-if="allData.length"
          size="default"
          type="danger"
          plain
          class="clear-btn"
          @click="clearAll"
        >
          🗑 清空全部
        </el-button>
        <el-input
          v-model="keyword"
          placeholder="搜索车号/弓位/故障类型..."
          clearable
          prefix-icon="Search"
          size="default"
          class="search-input"
        />
      </div>
    </div>

    <!-- 告警表格 -->
    <div class="table-wrapper">
      <el-table
        :data="filteredData"
        border
        height="100%"
        row-key="id"
        style="width: 100%;"
        class="alarm-table"
        :row-class-name="rowClassName"
      >
        <el-table-column prop="id" label="编号" width="150" align="center" />
        <el-table-column prop="time" label="时间" min-width="170" align="center">
          <template #default="{ row }">{{ formatTime(row.time) }}</template>
        </el-table-column>
        <el-table-column prop="carNumber" label="车号" min-width="90" align="center" />
        <el-table-column label="弓位" min-width="80" align="center">
          <template #default="{ row }">{{ row.camera || '—' }}</template>
        </el-table-column>
        <el-table-column prop="faultType" label="故障/磨损类型" min-width="130" align="center" />
        <el-table-column label="传感器数据" min-width="240" align="left">
          <template #default="{ row }">
            <span class="sensor-text">{{ sensorText(row.sensorData) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="AI 判读" min-width="220" align="left">
          <template #default="{ row }">
            <template v-if="row.vision === null">
              <span class="muted">推理中…</span>
            </template>
            <template v-else-if="row.vision === undefined">
              <span class="muted">—</span>
            </template>
            <template v-else-if="row.vision.ok">
              <el-tag :type="visionTag(row.vision.level)" size="small" effect="dark">
                {{ row.vision.level }}
              </el-tag>
              <div class="ai-text">{{ row.vision.text }}</div>
              <div v-if="row.vision.reasons && row.vision.reasons.length" class="ai-reasons">
                <div v-for="(r, i) in row.vision.reasons" :key="i">· {{ r }}</div>
              </div>
              <div v-if="row.vision.metrics && row.vision.metrics.L" class="ai-metrics">
                条长 {{ row.vision.metrics.L }}px · 厚 {{ row.vision.metrics.thick_median }}px
                (最薄 {{ row.vision.metrics.thick_p05 }}px) · 磨损候选 {{ row.vision.wear.length }} 处
              </div>
            </template>
            <span v-else class="muted">推理失败：{{ row.vision.error }}</span>
          </template>
        </el-table-column>
        <el-table-column label="图片" width="90" align="center">
          <template #default="{ row }">
            <el-button v-if="row.imageUrl" size="small" type="primary" plain @click="openImage(row)">
              🖼️ 预览
            </el-button>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="视频" width="90" align="center">
          <template #default="{ row }">
            <el-button v-if="row.videoUrl" size="small" type="success" plain @click="openVideo(row)">
              ▶ 播放
            </el-button>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="96" align="center" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              type="danger"
              plain
              :loading="deletingId === Number(row.id)"
              @click="removeRow(row)"
            >
              🗑 删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="filteredData.length === 0" class="empty-placeholder">
        <el-empty :description="keyword ? '无匹配记录' : '暂无黑盒子上传告警（等待 POST /api/upload-alarm）'" :image-size="80" />
      </div>
    </div>

    <!-- 图片大图预览 -->
    <el-image-viewer
      v-if="viewerImage"
      :url-list="[viewerImage]"
      @close="viewerImage = ''"
    />

    <!-- 视频播放弹窗 -->
    <el-dialog v-model="videoDialog" :title="videoRow ? `故障短视频 · 车号 ${videoRow.carNumber}` : '故障短视频'" width="720px" append-to-body destroy-on-close>
      <video
        v-if="videoDialog && videoRow && videoRow.videoUrl"
        :src="videoRow.videoUrl"
        controls
        autoplay
        style="width: 100%; max-height: 60vh; background: #000; border-radius: 6px;"
      />
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

// ============================================================
// 黑盒子告警监控页：纯 HTTP 轮询（无 WebSocket）
// 每 300ms 调用 GET /api/get-alarm-list，与上一次列表按 id 对比，
// 识别新增告警：自动刷新表格 + 弹窗提示新故障。
// ============================================================
const POLL_INTERVAL_MS = 300

const allData = ref([])
const keyword = ref('')
const pollError = ref(false)
const pollErrorMsg = ref('')
const viewerImage = ref('')
const videoDialog = ref(false)
const videoRow = ref(null)
// 新告警高亮（最近一次出现的新 id 集合，短暂高亮后淡出）
const freshIds = ref(new Set())
// 正在删除的记录 id（只让那一行的按钮转圈，不锁整张表）
const deletingId = ref(0)
let pollTimer = null
let freshTimer = null
let lastMaxId = null

const filteredData = computed(() => {
  const lower = keyword.value.trim().toLowerCase()
  // 最新记录排前面
  const sorted = [...allData.value].sort((a, b) => Number(b.id) - Number(a.id))
  if (!lower) return sorted
  return sorted.filter(item =>
    item.carNumber?.toLowerCase().includes(lower) ||
    item.camera?.toLowerCase().includes(lower) ||
    item.faultType?.toLowerCase().includes(lower) ||
    item.id?.toString().includes(lower)
  )
})

function sensorText(sensorData) {
  if (!sensorData || typeof sensorData !== 'object') return '—'
  const entries = Object.entries(sensorData)
  if (entries.length === 0) return '—'
  return entries.map(([k, v]) => `${k}: ${v}`).join('　')
}

function formatTime(t) {
  if (!t) return '—'
  const d = new Date(t)
  return isNaN(d.getTime()) ? t : d.toLocaleString('zh-CN', { hour12: false })
}

function rowClassName({ row }) {
  return freshIds.value.has(Number(row.id)) ? 'fresh-row' : ''
}

async function poll() {
  if (document.hidden) return          // 后台标签页不轮询，回到前台由 visibilitychange 恢复
  try {
    // sinceId 增量：首拉拉全量，之后只拉新增，减少轮询响应体
    const since = lastMaxId == null ? '' : `?sinceId=${lastMaxId}`
    const res = await fetch(`/api/get-alarm-list${since}`)
    if (res.status === 401) {          // 启用认证且未登录：提示而不是无脑重试
      pollError.value = true
      pollErrorMsg.value = '需要登录'
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    pollError.value = false
    pollErrorMsg.value = ''
    const list = Array.isArray(data.list) ? data.list : []
    if (lastMaxId == null) {
      // 首次全量：静默载入，不弹窗
      allData.value = list
    } else if (list.length > 0) {
      allData.value.push(...list)
      // 新增告警：弹窗提示（最多 3 条，避免一次补传几十条时刷屏）+ 短暂高亮
      const fresh = new Set()
      for (const item of list) fresh.add(Number(item.id))
      for (const item of list.slice(0, 3)) {
        ElNotification({
          title: '🚨 收到新故障告警',
          message: `车号 ${item.carNumber}${item.camera ? ' · ' + item.camera : ''} · ${item.faultType}\n${formatTime(item.time)}`,
          type: 'warning',
          duration: 6000
        })
      }
      if (list.length > 3) {
        ElNotification({
          title: `还有 ${list.length - 3} 条新告警`,
          message: '已在表格中高亮显示',
          type: 'info',
          duration: 5000
        })
      }
      freshIds.value = fresh
      if (freshTimer) clearTimeout(freshTimer)
      freshTimer = setTimeout(() => { freshIds.value = new Set() }, 8000)
    }
    if (allData.value.length > 0) {
      // 单调递增：删掉本地记录后不能把游标往回退，否则增量拉取会重复灌数据
      const m = Math.max(...allData.value.map(r => Number(r.id) || 0))
      lastMaxId = lastMaxId == null ? m : Math.max(lastMaxId, m)
    }
  } catch (err) {
    pollError.value = true
    pollErrorMsg.value = err.message
    console.warn('轮询失败:', err.message)
  }
}

function openImage(row) {
  // 有 AI 标注图就优先看标注图（框 + 磨损候选都画好了），没有才退回原图
  viewerImage.value = row?.vision?.annotatedUrl || row?.imageUrl
}

/** AI 判读标签配色：只有"疑似异常"给红，避免把"定位完成"也渲染成告警 */
function visionTag(level) {
  if (level === '疑似异常') return 'danger'
  if (level === '待复核') return 'warning'
  if (level === '未检出') return 'info'
  return 'success'
}

function openVideo(row) {
  videoRow.value = row
  videoDialog.value = true
}

/** 删除单条上传记录（服务端会连带删掉它的图片和视频文件） */
async function removeRow(row) {
  const id = Number(row.id)
  try {
    await ElMessageBox.confirm(
      `编号 ${id}｜${row.carNumber || '—'} · ${row.camera || '—'} · ${row.faultType || '—'}\n\n图片和视频会一并删除，且不可恢复。`,
      '确认删除这条数据？',
      {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger',
        customStyle: { whiteSpace: 'pre-line' },
      }
    )
  } catch {
    return // 用户取消
  }
  deletingId.value = id
  try {
    const res = await fetch(`/api/alarm/${id}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.success === false) {
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    allData.value = allData.value.filter(r => Number(r.id) !== id)
    // 正在播放/预览的是这条，顺手关掉，别让弹窗挂着一个已删文件
    if (videoRow.value && Number(videoRow.value.id) === id) {
      videoDialog.value = false
      videoRow.value = null
    }
    ElMessage.success(`已删除 ${id}`)
  } catch (err) {
    ElMessage.error(`删除失败：${err.message}`)
  } finally {
    deletingId.value = 0
  }
}

/** 清空当前列表里的全部上传记录（含图片/视频） */
async function clearAll() {
  const n = allData.value.length
  if (!n) {
    ElMessage.info('暂无记录')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将删除全部 ${n} 条记录及其图片、视频文件，不可恢复。`,
      '确认清空？',
      {
        type: 'warning',
        confirmButtonText: '全部删除',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger',
      }
    )
  } catch {
    return
  }
  try {
    const res = await fetch('/api/alarms?all=1', { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.success === false) {
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    allData.value = []
    freshIds.value = new Set()
    videoDialog.value = false
    videoRow.value = null
    ElMessage.success(`已清空 ${data.removed ?? n} 条`)
  } catch (err) {
    ElMessage.error(`清空失败：${err.message}`)
  }
}

function onVisibility() {
  if (document.hidden) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  } else if (!pollTimer) {
    poll()
    pollTimer = setInterval(poll, POLL_INTERVAL_MS)
  }
}

onMounted(() => {
  poll()
  pollTimer = setInterval(poll, POLL_INTERVAL_MS)
  document.addEventListener('visibilitychange', onVisibility)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (freshTimer) clearTimeout(freshTimer)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<style scoped>
.box-alarm-monitor {
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
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.poll-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #7ce5e5;
  white-space: nowrap;
}
.poll-status--err {
  color: #ff8f8f;
}
.poll-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: poll-blink 1.2s ease-in-out infinite;
}
@keyframes poll-blink {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

.search-input {
  width: 220px;
}
/* 清空按钮：暗色底上给个可辨认的边框，别和背景糊在一起 */
.clear-btn {
  flex-shrink: 0;
}
.clear-btn :deep(span),
.clear-btn {
  color: #ff9c9c;
}.search-input :deep(.el-input__wrapper) {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 20px;
  box-shadow: none;
  border: 1px solid rgba(255, 255, 255, 0.15);
}
.search-input :deep(.el-input__inner) {
  color: #fff;
}
.search-input :deep(.el-input__inner::placeholder) {
  color: rgba(255, 255, 255, 0.5);
}

.table-wrapper {
  flex: 1;
  position: relative;
  overflow: hidden;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.2);
}

.alarm-table {
  background: transparent;
}
.alarm-table :deep(.el-table__header-wrapper th) {
  background: #0a2e5d !important;
  color: #fff !important;
  font-weight: 600;
}
.alarm-table :deep(.el-table__row) {
  background: rgba(255, 255, 255, 0.04) !important;
  color: #e8edf3;
}
.alarm-table :deep(.el-table__row:hover) {
  background: rgba(123, 229, 229, 0.1) !important;
}
/* 新告警高亮：8 秒内保留泛光边框 */
.alarm-table :deep(.el-table__row.fresh-row) {
  background: rgba(255, 180, 60, 0.12) !important;
  box-shadow: inset 0 0 0 2px #ffbe4d;
}

.sensor-text {
  font-size: 12px;
  color: #b6e0ff;
  word-break: break-all;
}

.muted {
  color: rgba(255, 255, 255, 0.35);
}

.ai-text {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.82);
}

.ai-reasons {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.5;
  color: #ffd08a;
}

.ai-metrics {
  margin-top: 3px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  font-variant-numeric: tabular-nums;
}

.empty-placeholder {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 100%;
  text-align: center;
  pointer-events: none;
}
</style>
