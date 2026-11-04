import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isDev = mode === 'development'

  const plugins = [
    vue(),
    // Element Plus 按需自动引入：模板组件 + ElMessage/ElMessageBox 及对应样式
    AutoImport({
      resolvers: [ElementPlusResolver()],
      dts: false,
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: false,
    }),
  ]
  // vueDevTools 仅开发环境，生产构建不打包调试工具
  if (isDev) plugins.push(vueDevTools())

  return {
    plugins,
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // ========== 代理配置（API + WebSocket） ==========
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:3000', // 后端地址，如果端口不同请修改
          changeOrigin: true,
        },
        '/socket.io': {
          target: 'http://localhost:3000',
          ws: true,
          changeOrigin: true,
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          // 按库拆包：echarts / element-plus / datav / vendor（原为单个 2.6MB chunk）
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (/echarts|zrender/.test(id)) return 'echarts'
            if (/element-plus|@element-plus/.test(id)) return 'element-plus'
            if (/datav/.test(id)) return 'datav'
            return 'vendor'
          },
        },
      },
    },
  }
})
