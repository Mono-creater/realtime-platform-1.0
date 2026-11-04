import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'

/**
 * 认证状态：由 /api/auth/me 决定当前会话。
 * 后端默认关闭认证（AUTH_ENABLED != true），此时 enabled=false，所有页面照旧可访问。
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const enabled = ref(false)
  const publicRead = ref(true)
  const checked = ref(false)
  const loading = ref(false)

  async function fetchMe(force = false) {
    if (checked.value && !force) return user.value
    try {
      const { data } = await axios.get('/api/auth/me')
      enabled.value = !!data.enabled
      publicRead.value = data.publicRead !== false
      user.value = data.user || null
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
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err?.response?.data?.error || err.message || '登录失败' }
    } finally {
      loading.value = false
    }
  }

  async function logout() {
    try { await axios.post('/api/auth/logout') } catch { /* 忽略网络异常 */ }
    user.value = null
    checked.value = true
  }

  return { user, enabled, publicRead, checked, loading, fetchMe, login, logout }
})
