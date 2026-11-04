<template>
  <div class="layout">
    <el-row class="tac">
      <!-- 左侧菜单栏 -->
      <el-col :span="3">
        <LogoComponent />
        <LeftMenu></LeftMenu>
      </el-col>
      <!-- 右侧内容区域 -->
      <el-col class="right-content" :span="21">
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
import { useRouter } from 'vue-router'
import LogoComponent from '@/components/LogoComponent.vue'
import LeftMenu from '@/components/LeftMenu.vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()

async function onLogout() {
  await auth.logout()
  router.replace({ name: 'Login' })
}
</script>

<style scoped>
.layout {
  width: 100%;
  height: 100vh;
  overflow: hidden;
  position: relative;
}
.right-content {
  height: 100vh;
  overflow: auto;
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
</style>
