<!-- 受电弓详情页面 -->
<template>
  <div class="pantograph">
    <!-- 顶部导航栏 -->
    <div class="header">
      <div class="nav-bar">
        <!-- 返回按钮 -->
        <div class="back-btn-custom" @click="$router.go(-1)">
          <span>返回</span>
        </div>
        <!-- 中间标题 -->
        <div class="title">{{ trainNumber }}次列车受电弓详情</div>
        <!-- 右侧Logo -->
        <div
          @click="handleBack"
          class="nav-logo"
          style="height: 40px; display: flex; align-items: center; cursor: pointer"
        >
          <img
            src="/src/assets/images/yg_logo.png"
            alt="logo"
            style="height: 32px; vertical-align: middle"
          />
          <span
            style="margin-left: 5px; font-weight: bold; color: #fff; font-family: 'FZYTJW', sans-serif"
          >
            驭弓大师
          </span>
        </div>
      </div>
    </div>

    <!-- 内容区域 -->
    <div class="container">
      <!-- 左侧车组选择 -->
      <TrainSelect @trainChange="updateTrainNumber" />
      <!-- 右侧详情 -->
      <div class="trainDetail">
        <!-- 顶部地铁展示 -->
        <div class="metro">
          <div class="metro_img" :class="{ 'in-station': inStation }">
            <span class="pantograph-label label-1">1位</span>
            <span class="pantograph-label label-2">2位</span>
            <div class="train-light"></div>
          </div>
        </div>
        <!-- 受电弓信息展示 -->
        <div class="info">
          <carbon></carbon>
          <carbonInfo></carbonInfo>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import carbon from '@/components/pantograph/carbon.vue'
import TrainSelect from '@/components/pantograph/trainSelect.vue'
import carbonInfo from '@/components/pantograph/carbonInfo.vue'

const router = useRouter()
const trainNumber = ref('0503')
const inStation = ref(false)

const updateTrainNumber = (newTrain) => {
  trainNumber.value = newTrain
}

const handleBack = () => {
  router.push({ name: 'MonitorLine' })
}

onMounted(() => {
  setTimeout(() => {
    inStation.value = true
  }, 200)
})
</script>

<style scoped>
.pantograph {
  width: 100%;
  height: 100vh;
  background-color: #09182d;
  padding: 10px;
  box-sizing: border-box;
}

.header {
  width: 100%;
  height: 6%;
  margin-bottom: 10px;
}

.nav-bar {
  display: flex;
  align-items: center;
  height: 100%;
  justify-content: space-between;
  padding: 0 24px;
  box-sizing: border-box;
}

.title {
  flex: 1;
  text-align: center;
  color: #fff;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: 2px;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}

.back-btn-custom {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 20px;
  height: 40px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #fff;
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.25s ease;
  backdrop-filter: blur(4px);
  user-select: none;
  letter-spacing: 1px;
}

.back-btn-custom:hover {
  transform: scale(1.05);
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(0, 198, 255, 0.8);
  box-shadow: 0 0 20px rgba(0, 198, 255, 0.3);
  color: #00c6ff;
}

.back-btn-custom:active {
  transform: scale(0.95);
}

.container {
  width: 100%;
  height: 92%;
  display: flex;
}

.trainDetail {
  flex: 1;
  height: 100%;
}

.metro {
  width: 100%;
  height: 15%;
  margin-bottom: 10px;
  padding: 0 5px;
  box-sizing: border-box;
}

.metro_img {
  width: 100%;
  height: 100%;
  background-image: url('@/assets/images/metroImg3.png');
  background-size: 100% 100%;
  background-repeat: no-repeat;
  position: relative;
  transition: transform 1.2s cubic-bezier(0.77, 0, 0.18, 1);
  transform: translateX(100%); /* 初始在右侧 */
}

.metro_img.in-station {
  transform: translateX(0); /* 滑动到正常位置，实现从右向左进入 */
}

.pantograph-label {
  position: absolute;
  color: #7896cc;
  font-size: 12px;
  font-weight: bold;
  text-shadow: 0 0 4px #000;
  z-index: 2;
}

.label-1 {
  color: #467ada;
  top: -8px;
  left: 31%;
}

.label-2 {
  top: -10px;
  left: 70%;
}

.info {
  width: 100%;
  height: 100%;
  display: flex;
}
</style>