<template>
  <el-tooltip :disabled="allowed" :content="tip" placement="top" effect="dark">
    <span class="perm-btn-wrap">
      <el-button v-bind="$attrs" :disabled="!allowed || $attrs.disabled === true || $attrs.disabled === ''" @click="onClick">
        <slot />
      </el-button>
    </span>
  </el-tooltip>
</template>

<script setup>
/**
 * 权限按钮：无权限时自动置灰（Element Plus disabled 样式）并悬浮提示所需角色。
 * 用法：<PermissionButton level="admin" type="danger" size="small" @click="del">删除</PermissionButton>
 *   level=admin     → 仅管理员可用（删除、标定、用户管理…）
 *   level=operator  → 运维及以上可用（工单流转、告警确认、控制参数…）
 */
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({
  level: { type: String, default: 'admin' },
})
const emit = defineEmits(['click'])
const auth = useAuthStore()

const allowed = computed(() => (props.level === 'admin' ? auth.canManage : auth.canOperate))
const tip = computed(() => (props.level === 'admin' ? '需管理员权限' : '需运维及以上权限'))

function onClick(e) {
  if (!allowed.value) return
  emit('click', e)
}
</script>

<style scoped>
.perm-btn-wrap {
  display: inline-flex;
}
</style>
