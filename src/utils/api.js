import axios from 'axios'

// 统一的 axios 实例：走同源 + Vite 代理，避免硬编码 localhost:3000
const api = axios.create({
  baseURL: '/',
  timeout: 15000,
})

export default api
