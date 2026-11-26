import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import axios from 'axios'

/**
 * 认证状态：由 /api/auth/me 决定当前会话。
 * 后端默认关闭认证（AUTH_ENABLED != true），此时 enabled=false，所有页面照旧可访问。
 *
 * 角色：admin（管理人员）/ operator（运维）/ viewer（只读）
 *   canManage  → 删除告警、判据标定、用户管理等管理类动作
 *   canOperate → 工单流转、告警确认、控制参数等日常写操作
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const enabled = ref(false)
  const publicRead = ref(true)
  const allowRegister = ref(true)
  const checked = ref(false)
  const loading = ref(false)

  const role = computed(() => user.value?.role || (enabled.value ? 'viewer' : 'admin'))
  const isAdmin = computed(() => role.value === 'admin')
  const canOperate = computed(() => ['admin', 'operator'].includes(role.value))
  const canManage = computed(() => role.value === 'admin')
  const roleLabel = computed(() => ({ admin: '管理员', operator: '运维', viewer: '只读' }[role.value] || '只读'))

  function applyMe(data) {
    enabled.value = !!data.enabled
    publicRead.value = data.publicRead !== false
    allowRegister.value = data.allowRegister !== false
    user.value = data.user || null
  }

  async function fetchMe(force = false) {
    if (checked.value && !force) return user.value
    try {
      const { data } = await axios.get('/api/auth/me')
      applyMe(data)
    } catch {
      // 接口异常时不阻塞页面（退回“未启用认证”的宽松行为）
      enabled.value = false
      user.value = null
    }
    checked.value = true
    return user.value
  }

  async function login(username, password) {
    loading.value = true
    try {
      const { data } = await axios.post('/api/auth/login', { username, password })
      enabled.value = !!data.enabled
      user.value = data.user || null
      checked.value = true
      return { ok: true, user: user.value }
    } catch (err) {
      return { ok: false, error: err?.response?.data?.error || err.message || '登录失败' }
    } finally {
      loading.value = false
    }
  }

  async function register(username, password, displayName = '') {
    loading.value = true
    try {
      const { data } = await axios.post('/api/auth/register', { username, password, displayName })
      enabled.value = !!data.enabled
      user.value = data.user || null
      checked.value = true
      return { ok: true, user: user.value }
    } catch (err) {
      return { ok: false, error: err?.response?.data?.error || err.message || '注册失败' }
    } finally {
      loading.value = false
    }
  }

  async function logout() {
    try { await axios.post('/api/auth/logout') } catch { /* 忽略网络异常 */ }
    user.value = null
    checked.value = true
  }

  return {
    user, enabled, publicRead, allowRegister, checked, loading,
    role, isAdmin, canOperate, canManage, roleLabel,
    fetchMe, login, register, logout,
  }
})
