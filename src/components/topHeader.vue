<template>
  <div id="top-header">
    <dv-decoration-5 :color="['#1b4d9b', '#255da9']" class="header-center-decoration" />
    
    <!-- 左侧信息：安全运行天数 + 线路名称 -->
    <div class="left-info">
      <div class="runDays">
        <span>安全运行</span>
        <span class="days">{{ runDays }}</span>
        <span>天</span>
      </div>
      <div class="line-name">{{ lineLabel }}</div>
    </div>

    <!-- 中间标题 -->
    <div class="center-title">驭弓大师地铁车辆智慧运维平台</div>
    <!-- 右侧时间 -->
    <div class="nowtime">{{ nowTime }}</div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

// 运行天数（动态计算，参考之前的代码）
const runDays = ref(0)
const START_DATE = new Date('2024-12-01') // 按需修改

function updateDays() {
  const now = new Date()
  const diff = now - START_DATE
  runDays.value = Math.floor(diff / (1000 * 60 * 60 * 24))
}

// 实时时间
const nowTime = ref('')
function updateTime() {
  const date = new Date()
  const weekArr = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  const week = weekArr[date.getDay()]
  nowTime.value = `${y}年${m}月${d}日  ${h}:${min}:${s}  ${week}`
}

let clockTimer = null
onMounted(() => {
  updateDays()
  updateTime()
  clockTimer = setInterval(() => {
    updateDays()
    updateTime()
  }, 1000)
})

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
})
</script>

<style scoped>
#top-header {
  position: relative;
  width: 100%;
  height: 80px;
  display: flex;
  justify-content: center;
  align-items: center;
  background: transparent;
}
.header-center-decoration {
  width: 80%;
  height: 60px;
  margin-top: 20px;
  position: absolute;
  left: 10%;
  top: 0;
  z-index: 0;
}
.center-title {
  position: absolute;
  font-family: 'FZYTJW', sans-serif;
  font-size: 30px;
  font-weight: 500;
  left: 50%;
  top: 15px;
  transform: translateX(-50%);
  color: #fff;
  z-index: 1;
}
.left-info {
  position: absolute;
  left: 40px;
  top: 20px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.runDays {
  font-size: 16px;
  color: #fff;
}
.runDays .days {
  color: #1db14b;
  font-weight: bold;
  font-size: 30px;
  margin: 0 4px;
}
.line-name {
  font-size: 20px;
  font-weight: bold;
  color: #00c6ff;
  margin-top: 4px;
}
.nowtime {
  position: absolute;
  right: 40px;
  top: 10px;
  font-size: 14px;
  color: #fff;
  z-index: 1;
  letter-spacing: 1px;
}
</style>