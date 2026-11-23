<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { RouterView } from 'vue-router'

// ---- 大屏适配 ----
// 看板按 1440×1080 设计。手机端保持这个设计画布，用 transform 等比缩小：
//   · 横屏：画布缩到屏宽，高度自然超出屏幕 —— 由浏览器原生上下滚动查看（面板不再被裁切）
//   · 竖屏：整块旋转 90°，保证字能看清（旋转后纵向滚动在屏幕上是横向位移，故竖屏仅作预览）
const BASE_W = 1440
const BASE_H = 1080

const appRef = ref(null)
const boxRef = ref(null)
const stage = ref(null)
const isMobile = ref(false)
const isPortrait = ref(false)
const hintVisible = ref(false)
let hintTimer = null

const mqPortrait = window.matchMedia('(orientation: portrait)')
const uaMobile = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent)
const smallScreen = Math.min(window.screen.width, window.screen.height) < 768

function resetStage() {
  const app = appRef.value
  const box = boxRef.value
  const el = stage.value
  if (!app || !box || !el) return
  app.style.overflowY = ''
  app.style.overflowX = ''
  box.style.height = ''
  el.style.width = ''
  el.style.height = ''
  el.style.transform = ''
  el.style.position = ''
  el.style.top = ''
  el.style.left = ''
  document.documentElement.style.overflow = ''
}

function layout() {
  isMobile.value = uaMobile || smallScreen
  isPortrait.value = mqPortrait.matches

  const app = appRef.value
  const box = boxRef.value
  const el = stage.value
  if (!app || !box || !el) return

  if (!isMobile.value) {
    resetStage()
    return
  }

  const vw = document.documentElement.clientWidth || window.innerWidth
  const vh = document.documentElement.clientHeight || window.innerHeight
  if (!vw || !vh) return

  if (isPortrait.value) {
    // 竖屏：整块旋转 90°，并整体缩放到「完整可见」（contain），不裁切任何内容
    const k = Math.min(vw / BASE_H, vh / BASE_W)
    const scaledW = BASE_W * k   // 旋转后占屏幕高度
    const scaledH = BASE_H * k   // 旋转后占屏幕宽度
    app.style.overflowY = 'hidden'
    app.style.overflowX = 'hidden'
    box.style.height = '100%'
    el.style.position = 'fixed'
    el.style.top = '0'
    el.style.left = '0'
    el.style.width = BASE_W + 'px'
    el.style.height = BASE_H + 'px'
    el.style.transformOrigin = 'top left'
    el.style.transform =
      'translate(' + Math.round(scaledH + (vw - scaledH) / 2) + 'px, ' +
      Math.round((vh - scaledW) / 2) + 'px) rotate(90deg) scale(' + k + ')'
    if (!hintVisible.value) {
      hintVisible.value = true
      clearTimeout(hintTimer)
      hintTimer = setTimeout(() => { hintVisible.value = false }, 5000)
    }
  } else {
    // 横屏：设计画布 1440×1080 等比缩到屏宽，高度不足由原生滚动补齐
    const k = vw / BASE_W
    app.style.overflowY = 'auto'
    app.style.overflowX = 'hidden'
    box.style.height = Math.round(BASE_H * k) + 'px'
    el.style.position = 'absolute'
    el.style.top = '0'
    el.style.left = '0'
    el.style.width = BASE_W + 'px'
    el.style.height = BASE_H + 'px'
    el.style.transformOrigin = 'top left'
    el.style.transform = 'scale(' + k + ')'
    hintVisible.value = false
  }
  document.documentElement.style.overflow = 'hidden'
}

onMounted(async () => {
  await nextTick()
  layout()
  mqPortrait.addEventListener('change', layout)
  window.addEventListener('resize', layout)
  window.addEventListener('orientationchange', layout)
})

onBeforeUnmount(() => {
  clearTimeout(hintTimer)
  mqPortrait.removeEventListener('change', layout)
  window.removeEventListener('resize', layout)
  window.removeEventListener('orientationchange', layout)
})
</script>

<template>
  <div ref="appRef" class="app">
    <!-- 滚动容器：高度 = 缩放宽高，撑出可滚动范围 -->
    <div ref="boxRef" class="scrollbox">
      <div ref="stage" class="stage">
        <RouterView />
      </div>
    </div>

    <!-- 竖屏提示：轻量浮层，不遮挡内容，几秒后自动消失 -->
    <transition name="hint-fade">
      <div v-if="isMobile && isPortrait && hintVisible" class="rotate-hint">
        <svg class="hint-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            d="M7 4h6a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
          />
          <path d="M15 8h2a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-1" fill="none" stroke="currentColor" stroke-width="1.6" />
        </svg>
        <span>请把手机横过来，横屏后可上下滚动浏览</span>
      </div>
    </transition>
  </div>
</template>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
  padding: 0;
}

.app {
  width: 100%;
  height: 100%;
  padding: 0;
  margin: 0;
  background: #0b182c;
  overflow: hidden;
  -webkit-overflow-scrolling: touch;
}

.scrollbox {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.stage {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

/* 竖屏提示浮层 */
.rotate-hint {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 22px;
  background: rgba(10, 25, 45, 0.92);
  border: 1px solid rgba(0, 198, 255, 0.45);
  color: #d8e8fa;
  font-size: 14px;
  pointer-events: none;
}
.hint-icon {
  color: #00c6ff;
  animation: hint-rotate 2s ease-in-out infinite;
}
@keyframes hint-rotate {
  0%, 30% { transform: rotate(0deg); }
  65%, 100% { transform: rotate(90deg); }
}
.hint-fade-enter-active,
.hint-fade-leave-active {
  transition: opacity 0.5s ease;
}
.hint-fade-enter-from,
.hint-fade-leave-to {
  opacity: 0;
}
</style>
