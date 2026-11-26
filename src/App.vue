<script setup>
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { RouterView, useRoute } from 'vue-router'

// 移动端只做等比缩放，不改任何布局。
//  · 横屏：按屏宽缩放，高度超出部分原生上下滚动
//  · 竖屏：旋转 90° 并放大到「铺满屏幕」，超出的左右部分横向滑动查看
const BASE_W = 1440
const BASE_H = 1080

// iOS 与安卓分开处理：两端的可视区域、旋转行为差异很大
const ua = navigator.userAgent
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

const stage = ref(null)
const needRotateHint = ref(false)
let appEl = null
const route = useRoute()

function reset() {
  if (!appEl) return
  appEl.style.cssText = ''
  document.body.style.height = ''
  document.body.style.overflow = ''
  document.documentElement.style.overflow = ''
  const el = stage.value
  if (el) el.style.cssText = ''
}

function apply() {
  if (!appEl || !stage.value) return
  needRotateHint.value = false
  reset()

  // 登录/注册页不参与移动端等比缩放：它是普通表单页，按视口居中即可，
  // 若跟着 1440×1080 画布缩放，小窗口下卡片会被顶出可视区。
  if (route.name === 'Login') return

  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  if (!vw || !vh) return

  const shortEdge = Math.min(window.screen.width || vw, window.screen.height || vh)
  const isMobile = shortEdge < 768
  // 桌面窗口足够宽（≥ 设计宽度 1440）时不缩放；窗口被拖窄时与手机同样按宽度等比缩放，
  // 否则这套 1440 宽的大屏在 1080 宽窗口下会横向溢出、右侧 KPI 被裁掉。
  if (!isMobile && vw >= BASE_W) return

  const isPortrait = vh > vw
  document.documentElement.classList.toggle('is-ios', isIOS)
  const el = stage.value

  // 画布长宽比与屏幕保持一致：缩放后正好铺满，既无黑边也无需滚动
  // 画布长宽比严格跟随屏幕：缩放后正好铺满，不留死区、无需滚动
  const canvasH = Math.round(BASE_W * Math.min(vw, vh) / Math.max(vw, vh))
  el.style.width = BASE_W + 'px'
  el.style.height = canvasH + 'px'
  el.style.position = 'absolute'
  el.style.top = '0'
  el.style.left = '0'
  el.style.transformOrigin = 'top left'

  let visualW
  let visualH

  if (isMobile && isPortrait && isIOS) {
    // iOS：系统旋转可靠，竖屏只提示、不旋转内容
    const k = vw / BASE_W
    visualW = vw
    visualH = Math.round(canvasH * k)
    el.style.transform = 'scale(' + k + ')'
    needRotateHint.value = true
  } else if (isMobile && isPortrait) {
    // 安卓竖屏：内容旋转 90°，正好铺满竖屏
    const k = vh / BASE_W
    visualW = Math.round(canvasH * k)
    visualH = vh
    el.style.transform = 'translate(' + visualW + 'px, 0) rotate(90deg) scale(' + k + ')'
  } else {
    // 横屏（含桌面窄窗口）：按窗口宽度等比铺满
    const k = vw / BASE_W
    visualW = vw
    visualH = Math.round(canvasH * k)
    el.style.transform = 'scale(' + k + ')'
  }

  appEl.style.position = 'relative'
  appEl.style.width = visualW + 'px'
  appEl.style.height = visualH + 'px'
  appEl.style.overflow = 'hidden'

  document.documentElement.style.height = 'auto'
  document.body.style.height = 'auto'
  document.body.style.overflow = 'auto'
  document.body.style.overflowX = 'hidden'
  document.body.style.overflowY = 'hidden'


}

onMounted(() => {
  appEl = document.getElementById('app')
  apply()
  window.addEventListener('resize', apply)
  window.addEventListener('orientationchange', apply)
  if (window.visualViewport) window.visualViewport.addEventListener('resize', apply)
})
// 进出登录页时重新计算：登录页不缩放，其他页面恢复看板缩放
watch(() => route.name, () => {
  nextTick(() => { if (appEl) apply() })
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', apply)
  window.removeEventListener('orientationchange', apply)
  if (window.visualViewport) window.visualViewport.removeEventListener('resize', apply)
})
</script>

<template>
  <div ref="stage" class="stage">
    <RouterView />
  </div>
  <div v-if="needRotateHint" class="ios-rotate-hint">
    <div class="ios-hint-inner">
      <p class="ios-hint-title">请把手机横过来</p>
      <p class="ios-hint-desc">本平台为横屏看板，转成横屏后自动进入</p>
    </div>
  </div>
</template>

<style>
html,
body,
#app {
  margin: 0;
  padding: 0;
  background: #0b182c;
}
html,
body {
  height: 100%;
}
#app {
  /* 必须是确定高度而不是 min-height：各页面用 height:100% + 百分比分栏，
     父级为 auto 时百分比全部退化为内容高度，页面会超出视口并出现滚动/底部空白 */
  height: 100%;
  min-height: 100%;
}
/* 画布容器同样撑满；移动端等比缩放时由行内 width/height 覆盖 */
.stage {
  width: 100%;
  height: 100%;
}

/* 让列布局的高度能一路传递到页面根，否则 flex:1 的表格区拿不到高度 */
.layout > .el-row {
  height: 100%;
}

.ios-rotate-hint {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(ellipse at 50% 0%, #123a63 0%, #0a1526 62%);
  color: #e8f1fb;
  text-align: center;
}
.ios-hint-title {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 600;
}
.ios-hint-desc {
  margin: 0;
  font-size: 13px;
  color: #9fb6cc;
}
</style>
