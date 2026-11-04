import {createApp} from 'vue'
import {createPinia} from 'pinia'
import DataVVue3 from '@kjgl77/datav-vue3'
import axios from 'axios'
import './assets/fonts.css'
import './assets/v3-pages.css'

import App from './App.vue'
import router from './router'

// 若后端在 .env 配置了 API_TOKEN，写接口（改 PID / 删告警 / 切模式 / 工单流转）需要令牌。
// 令牌从浏览器 localStorage 读取（可在控制台执行 localStorage.setItem('API_TOKEN','<token>') 注入）；
// 未配置令牌时该拦截器无任何副作用，保持原有可用性。
axios.interceptors.request.use((cfg) => {
  try {
    const token = localStorage.getItem('API_TOKEN')
    if (token) cfg.headers['X-API-Token'] = token
  } catch { /* 隐私模式等场景忽略 */ }
  return cfg
})

// 会话失效：仅针对认证中间件返回的 401（code=AUTH_REQUIRED），
// 不影响 API_TOKEN 缺失导致的 401，避免未启用认证时被误跳到登录页。
axios.interceptors.response.use(
  (r) => r,
  (err) => {
    const status = err?.response?.status
    const code = err?.response?.data?.code
    const url = String(err?.config?.url || '')
    if (status === 401 && code === 'AUTH_REQUIRED' && !url.includes('/api/auth/')) {
      const here = window.location.pathname + window.location.search
      if (!here.startsWith('/login')) {
        window.location.assign('/login?redirect=' + encodeURIComponent(here))
      }
    }
    return Promise.reject(err)
  }
)

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(DataVVue3)

app.mount('#app')
