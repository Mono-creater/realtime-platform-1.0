<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { RouterView } from 'vue-router'

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

  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  if (!vw || !vh) return

  const shortEdge = Math.min(window.screen.width || vw, window.screen.height || vh)
  if (shortEdge >= 768) return // 非手机不做任何变换

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

  if (isPortrait && isIOS) {
    // iOS：系统旋转可靠，竖屏只提示、不旋转内容
    const k = vw / BASE_W
    visualW = vw
    visualH = Math.round(canvasH * k)
    el.style.transform = 'scale(' + k + ')'
    needRotateHint.value = true
  } else if (isPortrait) {
    // 安卓竖屏：内容旋转 90°，正好铺满竖屏
    const k = vh / BASE_W
    visualW = Math.round(canvasH * k)
    visualH = vh
    el.style.transform = 'translate(' + visualW + 'px, 0) rotate(90deg) scale(' + k + ')'
  } else {
    // 横屏：按屏宽等比铺满；iOS 画布更高，可上下滑动查看
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
  min-height: 100%;
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
