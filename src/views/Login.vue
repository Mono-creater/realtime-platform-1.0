<template>
  <div class="login-page">
    <div class="login-card">
      <div class="brand">驭弓大师</div>
      <div class="subtitle">城轨受电弓碳滑板监测平台</div>

      <template v-if="auth.enabled">
        <el-form class="form" @submit.prevent="submit">
          <el-input v-model="username" placeholder="用户名" size="large" autocomplete="username" />
          <el-input
            v-model="password"
            type="password"
            placeholder="密码"
            size="large"
            show-password
            autocomplete="current-password"
            @keyup.enter="submit"
          />
          <el-button type="primary" size="large" :loading="auth.loading" class="submit" @click="submit">
            登录
          </el-button>
          <div v-if="error" class="error">{{ error }}</div>
        </el-form>
        <div class="hint">只读账号可查看全部页面；写操作（改 PID、删告警、工单流转）需运维账号。</div>
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
const error = ref('')

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
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(ellipse at 50% 0%, #123a63 0%, #0b182c 60%);
  color: #fff;
}
.login-card {
  width: 360px;
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
