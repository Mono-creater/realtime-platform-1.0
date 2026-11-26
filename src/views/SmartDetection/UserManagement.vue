<template>
  <div class="v3-page">
    <div class="v3-head">
      <span class="v3-h1">用户管理</span>
      <span class="v3-sub">注册表账号与角色：管理员可管理用户；运维可执行工单/告警/控制等写操作；只读仅浏览</span>
    </div>

    <div class="v3-grid v3-grid-4">
      <div class="v3-kpi" style="--kpi-color:#00c6ff">
        <div class="v3-kpi-label">账号总数</div>
        <div class="v3-kpi-value">{{ list.length }}<small>个</small></div>
        <div class="v3-kpi-foot">存储：{{ mode === 'mysql' ? 'MySQL users 表' : '内存（重启丢失）' }}</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#c9184a">
        <div class="v3-kpi-label">管理员</div>
        <div class="v3-kpi-value">{{ countRole('admin') }}<small>个</small></div>
        <div class="v3-kpi-foot">删除告警 / 判据标定 / 用户管理</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#ffaa00">
        <div class="v3-kpi-label">运维</div>
        <div class="v3-kpi-value">{{ countRole('operator') }}<small>个</small></div>
        <div class="v3-kpi-foot">工单流转 / 告警确认 / 控制参数</div>
      </div>
      <div class="v3-kpi" style="--kpi-color:#00d68f">
        <div class="v3-kpi-label">只读</div>
        <div class="v3-kpi-value">{{ countRole('viewer') }}<small>个</small></div>
        <div class="v3-kpi-foot">新注册账号默认角色</div>
      </div>
    </div>

    <div class="v3-card" style="margin-top:14px">
      <div class="v3-card-title">
        注册账号
        <span class="hint">角色调整立即生效；停用后该账号已登录的会话也会失效</span>
        <el-button size="small" type="primary" style="margin-left:auto" @click="openCreate">新建账号</el-button>
      </div>
      <div class="v3-table">
        <el-table :data="list" height="calc(100% - 210px)" style="width:100%" v-loading="loading">
          <el-table-column prop="username" label="用户名" width="160" />
          <el-table-column label="姓名 / 称呼" width="150">
            <template #default="{ row }">{{ row.displayName || '—' }}</template>
          </el-table-column>
          <el-table-column label="角色" width="170">
            <template #default="{ row }">
              <el-select
                :model-value="row.role"
                size="small"
                :disabled="row.id === auth.user?.id"
                @change="(v) => changeRole(row, v)"
              >
                <el-option label="管理员" value="admin" />
                <el-option label="运维" value="operator" />
                <el-option label="只读" value="viewer" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110" align="center">
            <template #default="{ row }">
              <el-switch
                :model-value="row.enabled"
                :disabled="row.id === auth.user?.id"
                @change="(v) => toggleEnabled(row, v)"
              />
            </template>
          </el-table-column>
          <el-table-column label="创建时间" width="170">
            <template #default="{ row }">{{ fmt(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="最近登录" width="170">
            <template #default="{ row }">{{ fmt(row.lastLoginAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" min-width="200">
            <template #default="{ row }">
              <el-button size="small" link type="primary" @click="openReset(row)">重置密码</el-button>
              <el-button
                size="small"
                link
                type="danger"
                :disabled="row.id === auth.user?.id"
                @click="removeUser(row)"
              >删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div class="foot">
        安全说明：密码以 scrypt 加盐哈希存储；修改角色/停用账号即时生效。
        至少保留一个管理员账号，且不能删除或降级当前登录的自己。
      </div>
    </div>

    <!-- 新建账号 -->
    <el-dialog v-model="createVisible" title="新建账号" width="420px">
      <el-form label-width="84px">
        <el-form-item label="用户名">
          <el-input v-model="form.username" placeholder="3~32 位字母/数字/下划线" />
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="form.displayName" placeholder="可选" />
        </el-form-item>
        <el-form-item label="初始密码">
          <el-input v-model="form.password" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width:100%">
            <el-option label="只读" value="viewer" />
            <el-option label="运维" value="operator" />
            <el-option label="管理员" value="admin" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码 -->
    <el-dialog v-model="resetVisible" :title="`重置密码：${resetUser?.username || ''}`" width="400px">
      <el-input v-model="resetPassword" type="password" show-password placeholder="新密码（至少 6 位）" />
      <template #footer>
        <el-button @click="resetVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitReset">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/utils/api'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const list = ref([])
const mode = ref('memory')
const loading = ref(false)
const saving = ref(false)

const createVisible = ref(false)
const resetVisible = ref(false)
const resetUser = ref(null)
const resetPassword = ref('')
const form = reactive({ username: '', displayName: '', password: '', role: 'viewer' })

const countRole = (r) => list.value.filter((u) => u.role === r).length
const fmt = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—')

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/api/users')
    list.value = data.list || []
    mode.value = data.mode || 'memory'
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '加载用户列表失败')
  } finally {
    loading.value = false
  }
}

function openCreate() {
  Object.assign(form, { username: '', displayName: '', password: '', role: 'viewer' })
  createVisible.value = true
}

async function submitCreate() {
  saving.value = true
  try {
    await api.post('/api/users', { ...form })
    ElMessage.success('账号已创建')
    createVisible.value = false
    await load()
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '创建失败')
  } finally {
    saving.value = false
  }
}

async function changeRole(row, role) {
  try {
    await api.patch(`/api/users/${row.id}`, { role })
    ElMessage.success(`已将 ${row.username} 设为${role === 'admin' ? '管理员' : role === 'operator' ? '运维' : '只读'}`)
    await load()
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '修改失败')
  }
}

async function toggleEnabled(row, enabled) {
  try {
    await api.patch(`/api/users/${row.id}`, { enabled })
    ElMessage.success(enabled ? '已启用' : '已停用')
    await load()
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '操作失败')
  }
}

function openReset(row) {
  resetUser.value = row
  resetPassword.value = ''
  resetVisible.value = true
}

async function submitReset() {
  if (resetPassword.value.length < 6) {
    ElMessage.warning('新密码至少 6 位')
    return
  }
  saving.value = true
  try {
    await api.patch(`/api/users/${resetUser.value.id}`, { password: resetPassword.value })
    ElMessage.success('密码已重置')
    resetVisible.value = false
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '重置失败')
  } finally {
    saving.value = false
  }
}

async function removeUser(row) {
  try {
    await ElMessageBox.confirm(`确认删除账号「${row.username}」？该操作不可恢复。`, '删除账号', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消',
    })
    await api.delete(`/api/users/${row.id}`)
    ElMessage.success('已删除')
    await load()
  } catch (err) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(err?.response?.data?.error || '删除失败')
  }
}

onMounted(load)
</script>

<style scoped>
.foot { margin-top: 12px; font-size: 12px; color: #7a8b9f; line-height: 1.7; }
:deep(.v3-card-title) { display: flex; align-items: center; gap: 10px; }
</style>
