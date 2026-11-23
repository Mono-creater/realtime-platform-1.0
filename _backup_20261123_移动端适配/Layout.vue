<template>
  <div ref="rootRef" class="layout">
    <!-- 移动端汉堡按钮 -->
    <button v-if="isMobile" class="mobile-menu-btn" aria-label="打开菜单" @click="menuOpen = true">
      <span></span><span></span><span></span>
    </button>
    <!-- 移动端抽屉菜单 -->
      <el-drawer v-model="menuOpen" direction="ltr" size="72%" :with-header="false" class="mobile-drawer">
        <div class="drawer-inner">
          <LogoComponent />
          <LeftMenu></LeftMenu>
        </div>
      </el-drawer>
    <el-row class="tac">
      <!-- 左侧菜单栏（桌面端） -->
      <el-col v-if="!isMobile" :span="3">
        <LogoComponent />
        <LeftMenu></LeftMenu>
      </el-col>
      <!-- 右侧内容区域 -->
      <el-col class="right-content" :span="isMobile ? 24 : 21">
        <router-view></router-view>
      </el-col>
    </el-row>

    <!-- 当前登录用户（仅启用认证时显示） -->
    <div v-if="auth.enabled && auth.user" class="user-chip">
      <span class="avatar">{{ (auth.user.u || '?').slice(0, 1).toUpperCase() }}</span>
      <span class="name">{{ auth.user.u }}</span>
      <span class="role">{{ auth.user.role === 'operator' ? '运维' : '只读' }}</span>
      <el-button link size="small" class="logout" @click="onLogout">退出</el-button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import LogoComponent from '@/components/LogoComponent.vue'
import LeftMenu from '@/components/LeftMenu.vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

// 是否用移动端布局：按「布局容器自身宽度」判断，而不是视口宽度。
// 手机端整块看板是放大到 1440 再整体缩放的，容器实际宽度仍是 1440，
// 因此应保持桌面布局（左侧菜单常驻），不出现汉堡按钮。
const rootRef = ref(null)
const isMobile = ref(false)
let ro = null

function measure() {
  const el = rootRef.value
  if (!el) return
  isMobile.value = el.clientWidth > 0 && el.clientWidth < 768
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && rootRef.value) {
    ro = new ResizeObserver(measure)
    ro.observe(rootRef.value)
  } else {
    window.addEventListener('resize', measure)
  }
})

onBeforeUnmount(() => {
  if (ro) ro.disconnect()
  else window.removeEventListener('resize', measure)
})

// 移动端抽屉菜单开关；路由切换后自动收起
const menuOpen = ref(false)
watch(() => route.fullPath, () => { menuOpen.value = false })

async function onLogout() {
  await auth.logout()
  router.replace({ name: 'Login' })
}
</script>

<style scoped>
.layout {
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}
.right-content {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
}
.user-chip {
  position: absolute;
  left: 12px;
  bottom: 12px;
  width: calc(25% - 24px);
  max-width: 190px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #cfe3f7;
  font-size: 12px;
  z-index: 10;
}
.avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(0, 198, 255, 0.25);
  color: #00c6ff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  flex-shrink: 0;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.role {
  color: #7a8b9f;
  flex-shrink: 0;
}
.logout {
  margin-left: auto;
  flex-shrink: 0;
}

/* ---- 移动端适配 ---- */
.mobile-menu-btn {
  display: none;
}
.drawer-inner {
  height: 100%;
  overflow-y: auto;
}

@media (max-width: 768px) {
  .mobile-menu-btn {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 2000;
    width: 42px;
    height: 36px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    background: rgba(10, 25, 45, 0.85);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 0;
  }
  .mobile-menu-btn span {
    display: block;
    width: 20px;
    height: 2px;
    border-radius: 1px;
    background: #cfe3f7;
  }
  .user-chip {
    width: auto;
    max-width: 60%;
    bottom: 10px;
    left: 10px;
  }
}
</style>
