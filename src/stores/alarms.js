/**
 * useAlarmStore —— 全站告警列表的单一数据源
 *
 * 解决的问题（1.2 优化）：
 *   1) 五个页面各自 `GET /api/history`，切页就重复拉 500 条；
 *   2) 每个页面各自监听 `fullUpdate` 并整表替换，服务端每次要广播约 100 KB；
 *   3) 增删改后各页面的本地状态各自维护，容易出现"这页删了那页还在"。
 *
 * 现在的约定：
 *   · 首个调用 bind() 的页面注册唯一一组 Socket 监听，其余页面只读 store；
 *   · 服务端 `fullUpdate` 有两种帧：type='full'（连接首帧/批量操作，带 warningList）
 *     与 type='delta'（单条增删，带 upserts/removed），这里统一收敛；
 *   · 组件卸载不注销监听（store 与 App 同生命周期），避免来回切页重复注册。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'
import socket from '@/socket'

const MAX_ROWS = 500
const MIN_RELOAD_MS = 5000

function tsOf(w) {
  const t = new Date(w && (w.timeFull || w.time)).getTime()
  return Number.isFinite(t) ? t : 0
}

export const useAlarmStore = defineStore('alarms', () => {
  /** 全量告警（含环境类），按时间倒序 */
  const list = ref([])
  /** /api/stats/summary 的聚合结果（健康度、在线数、处理率、链路质量等） */
  const summary = ref({})
  const loading = ref(false)
  const loadedAt = ref(0)
  const version = ref(0)
  const connected = ref(socket.connected)
  const lastError = ref('')

  let bound = false
  let inflight = null
  let summaryTimer = null

  function sortInPlace() {
    list.value.sort((a, b) => tsOf(b) - tsOf(a))
  }

  /**
   * 全量加载（默认 5 s 内复用上次结果，避免多页面同时挂载时重复请求）
   */
  function load({ force = false } = {}) {
    if (inflight) return inflight
    if (!force && loadedAt.value && Date.now() - loadedAt.value < MIN_RELOAD_MS) return Promise.resolve()
    inflight = (async () => {
      loading.value = true
      try {
        const [h, s] = await Promise.all([
          axios.get('/api/history', { params: { limit: MAX_ROWS } }),
          axios.get('/api/stats/summary').catch(() => ({ data: {} })),
        ])
        if (Array.isArray(h.data)) {
          list.value = h.data
          sortInPlace()
        }
        summary.value = s.data || {}
        loadedAt.value = Date.now()
        lastError.value = ''
      } catch (err) {
        lastError.value = err?.message || '加载失败'
      } finally {
        loading.value = false
        inflight = null
      }
    })()
    return inflight
  }

  async function refreshSummary() {
    try {
      const { data } = await axios.get('/api/stats/summary')
      summary.value = data || {}
    } catch { /* 保留上一次的统计值 */ }
  }

  /**
   * 应用增量帧：upserts 按 id 覆盖/新增，removed 按 id 删除
   * @returns {boolean} 是否有实际变化
   */
  function applyDelta(payload = {}) {
    const removed = Array.isArray(payload.removed) ? payload.removed : []
    const upserts = Array.isArray(payload.upserts) ? payload.upserts : []
    if (!removed.length && !upserts.length) return false

    if (removed.length) {
      const set = new Set(removed.map(Number))
      list.value = list.value.filter(w => !set.has(Number(w.id)))
    }
    if (upserts.length) {
      const map = new Map(list.value.map(w => [Number(w.id), w]))
      for (const w of upserts) map.set(Number(w.id), w)
      list.value = [...map.values()]
      sortInPlace()
    }
    loadedAt.value = Date.now()
    return true
  }

  /** 注册全局 Socket 监听（幂等），并触发首次加载 */
  function bind() {
    if (bound) return
    bound = true

    socket.on('connect', () => {
      connected.value = true
      load({ force: true })
    })
    socket.on('disconnect', () => { connected.value = false })

    socket.on('fullUpdate', (data) => {
      if (!data) return
      // 乱序保护：版本号回退的帧直接忽略
      if (typeof data.version === 'number') {
        if (data.version < version.value) return
        version.value = data.version
      }
      if (Array.isArray(data.warningList)) {
        list.value = data.warningList
        sortInPlace()
        loadedAt.value = Date.now()
      } else if (applyDelta(data)) {
        refreshSummary()
      }
    })

    // 兜底：WS 正常时也每 60 s 对齐一次，防止极端丢帧导致列表漂移
    if (!summaryTimer) {
      summaryTimer = setInterval(() => {
        if (socket.connected) load({ force: true })
      }, 60000)
    }

    connected.value = socket.connected
    load()
  }

  /** 本地立即移除（删除接口返回后调用，无需等待广播） */
  function removeLocal(id) {
    list.value = list.value.filter(w => Number(w.id) !== Number(id))
  }

  return {
    list, summary, loading, loadedAt, version, connected, lastError,
    load, refreshSummary, applyDelta, bind, removeLocal,
  }
})
