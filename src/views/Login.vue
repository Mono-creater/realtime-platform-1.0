<template>
  <div class="login-page">
    <div class="login-card">
      <div class="brand">驭弓大师</div>
      <div class="subtitle">城轨受电弓碳滑板监测平台</div>

      <template v-if="auth.enabled">
        <div class="tabs">
          <button class="tab" :class="{ active: mode === 'login' }" @click="switchMode('login')">登录</button>
          <button v-if="auth.allowRegister" class="tab" :class="{ active: mode === 'register' }" @click="switchMode('register')">注册</button>
        </div>

        <el-form class="form" @submit.prevent="submit">
          <el-input v-model="username" placeholder="用户名" size="large" autocomplete="username" />
          <el-input
            v-if="mode === 'register'"
            v-model="displayName"
            placeholder="姓名 / 工号称呼（可选）"
            size="large"
            autocomplete="name"
          />
          <el-input
            v-model="password"
            type="password"
            placeholder="密码（至少 6 位）"
            size="large"
            show-password
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            @keyup.enter="submit"
          />
          <el-input
            v-if="mode === 'register'"
            v-model="password2"
            type="password"
            placeholder="确认密码"
            size="large"
            show-password
            autocomplete="new-password"
            @keyup.enter="submit"
          />
          <el-button type="primary" size="large" :loading="auth.loading" class="submit" @click="submit">
            {{ mode === 'login' ? '登录' : '注册并登录' }}
          </el-button>
          <div v-if="error" class="error">{{ error }}</div>
        </el-form>
        <div class="hint">
          新注册账号默认为<b>只读</b>，可查看全部页面；工单流转等写操作需运维权限，
          删除告警、判据标定、用户管理仅<b>管理员</b>可操作（无权限按钮显示为灰色）。
        </div>
      </template>

      <template v-else>
        <div class="disabled">
          <p>当前未启用认证。</p>
          <p class="muted">在 <code>.env</code> 设置 <code>AUTH_ENABLED=true</code> 并配置账号后重启即可启用。</p>
          <el-button type="primary" @click="goHome">进入平台</el-button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const username = ref('')
const password = ref('')
const password2 = ref('')
const displayName = ref('')
const error = ref('')
const mode = ref('login')

function switchMode(m) {
  mode.value = m
  error.value = ''
}

function goHome() {
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/monitor_line'
  router.replace(redirect)
}

async function submit() {
  error.value = ''
  if (!username.value || !password.value) {
    error.value = '请输入用户名与密码'
    return
  }
  if (mode.value === 'register') {
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username.value)) {
      error.value = '用户名需为 3~32 位字母、数字或下划线'
      return
    }
    if (password.value.length < 6) {
      error.value = '密码至少 6 位'
      return
    }
    if (password.value !== password2.value) {
      error.value = '两次输入的密码不一致'
      return
    }
    const r = await auth.register(username.value, password.value, displayName.value)
    if (!r.ok) {
      error.value = r.error
      return
    }
    goHome()
    return
  }
  const r = await auth.login(username.value, password.value)
  if (!r.ok) {
    error.value = r.error
    return
  }
  goHome()
}

onMounted(async () => {
  await auth.fetchMe()
  if (!auth.enabled) goHome()
})
</script>

<style scoped>
.login-page {
  width: 100%;
  min-height: 100vh;   /* 按视口高度居中，小窗口下可滚动，不再被画布缩放顶出可视区 */
  height: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  box-sizing: border-box;
  background: radial-gradient(ellipse at 50% 0%, #123a63 0%, #0b182c 60%);
  color: #fff;
}
.login-card {
  width: 360px;
  margin: auto;
  flex-shrink: 0;
  padding: 32px 28px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
}
.brand {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: 2px;
  color: #00c6ff;
}
.subtitle {
  font-size: 13px;
  color: #9fb6cc;
  margin: 6px 0 24px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.tab {
  flex: 1;
  padding: 8px 0;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: transparent;
  color: #9fb6cc;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.tab.active {
  color: #00c6ff;
  border-color: rgba(0, 198, 255, 0.6);
  background: rgba(0, 198, 255, 0.08);
}
.submit {
  width: 100%;
  margin-top: 4px;
}
.error {
  color: #ff6b81;
  font-size: 12px;
  min-height: 16px;
}
.hint {
  margin-top: 16px;
  font-size: 12px;
  color: #6b7d92;
  line-height: 1.7;
}
.disabled p {
  margin: 0 0 8px;
  font-size: 14px;
}
.muted {
  color: #9fb6cc;
  font-size: 12px;
  line-height: 1.7;
}
code {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  padding: 0 4px;
}
</style>
