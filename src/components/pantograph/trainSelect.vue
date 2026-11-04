<template>
  <div class="trainSelect">
    <dv-border-box-8>
      <div class="trainSelect-inner">
        <!-- 标题 -->
        <div class="train-title-row">
          <span class="train-title-tag"></span>
          <span class="train-title-text">车组选择</span>
        </div>

        <!-- 搜索框（修正 size） -->
        <el-input
          v-model="searchText"
          placeholder="车组"
          :prefix-icon="Search"
          size="default"
          style="margin-bottom: 10px"
          class="train-search-input"
        />

        <!-- 车组按钮列表 -->
        <div class="train-btn-list">
          <el-button
            v-for="train in filteredTrainList"
            :key="train.id"
            class="train-btn"
            :style="getTrainBtnStyle(train)"
            @click="selectTrain(train.id)"
          >
            {{ train.id }}
          </el-button>
        </div>
      </div>
    </dv-border-box-8>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { Search } from '@element-plus/icons-vue'

// ---------- 定义事件 ----------
const emit = defineEmits(['trainChange'])

// ---------- Mock 车组数据 ----------
const trainList = [
  { id: '0503', status: 'green' },
  { id: '0504', status: 'green' },
  { id: '0505', status: 'default' },
  { id: '0506', status: 'default' },
  { id: '0507', status: 'red' },
  { id: '0518', status: 'red' },
  { id: '0519', status: 'purple' },
  { id: '0520', status: 'purple' },
  { id: '0521', status: 'pink' },
  { id: '0523', status: 'pink' },
  { id: '0524', status: 'gold' },
  { id: '0530', status: 'gold' },
  { id: '0531', status: 'blue' },
  { id: '0533', status: 'blue' },
]

// ---------- 状态 ----------
const searchText = ref('')
const selectedTrain = ref(trainList[0]?.id || '')

// ---------- 过滤列表 ----------
const filteredTrainList = computed(() => {
  if (!searchText.value) return trainList
  return trainList.filter((t) => t.id.includes(searchText.value))
})

// ---------- 选中车次 ----------
function selectTrain(id) {
  selectedTrain.value = id
  // 通知父组件车次改变
  emit('trainChange', id)
}

// ---------- 按钮样式 ----------
function getTrainBtnStyle(train) {
  const isSelected = selectedTrain.value === train.id
  const base = {
    width: '100%',
    marginBottom: '8px',
    fontSize: '18px',
    borderRadius: '10px',
    border: isSelected ? '2px solid #fff' : 'none',
    color: train.status === 'blue' ? '#fff' : '#222',
    backgroundColor: '#fff',
    boxShadow: 'none',
    height: '33px',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 0,
  }
  switch (train.status) {
    case 'green':
      base.backgroundColor = '#7fffc5'  //绿色
      break
    case 'orange':
      base.backgroundColor = '#ffc600'  //橘色
      break
    case 'red':
      base.backgroundColor = '#ff2323'  //红色
      base.color = '#fff'
      break
    case 'blue':
      base.backgroundColor = '#3772c8'  //蓝色
      base.color = '#fff'
      break
       case 'purple':
      base.backgroundColor = '#a855f7'  // 紫色
      base.color = '#fff'
      break
    case 'pink':
      base.backgroundColor = '#f472b6'  // 粉色
      base.color = '#fff'
      break
    case 'gold':
      base.backgroundColor = '#facc15'  // 金色（亮黄）
      base.color = '#222'  // 金色背景用深色文字更清晰
      break
       default:
      // 默认白色背景
      base.backgroundColor = '#ffffff'
      base.color = '#222'
  }
  return base
}
</script>

<style scoped>
.trainSelect {
  width: 13%;
  height: 100%;
  margin-right: 10px;
  padding: 0 5px;
  box-sizing: border-box;
}
.trainSelect-inner {
  padding: 16px 10px 10px;
  box-sizing: border-box;
  height: 100%;
}
.train-title-row {
  display: flex;
  align-items: center;
  margin: 5px 0 10px 0;
}
.train-title-tag {
  display: inline-block;
  width: 6px;
  height: 28px;
  background: #7be5e5;
  border-radius: 2px;
  margin-right: 10px;
}
.train-title-text {
  color: #fff;
  font-size: 20px;
  letter-spacing: 2px;
}
.train-search-input {
  width: 100%;
}
.train-btn-list {
  width: 100%;
  display: flex;
  flex-direction: column;
  padding: 0;
  box-sizing: border-box;
}
.train-btn {
  width: 100%;
  font-size: 16px;
  border-radius: 12px;
  border: none;
  height: 30px;
  margin: 0 0 5px 0;
  justify-content: center;
  align-items: center;
  display: flex;
  padding: 0;
  transition: border 0.2s;
  box-sizing: border-box;
}
.train-btn:last-child {
  margin-bottom: 0;
}
.train-btn:focus {
  outline: none;
}
.train-search-input :deep(.el-input__wrapper) {
  background-color: transparent !important;
}
</style>