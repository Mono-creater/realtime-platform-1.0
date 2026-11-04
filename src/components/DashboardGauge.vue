<template>
  <!-- 仪表盘组件 -->
  <div class="dashboard-gauge-container" :style="{ width: `${size}px` }" @click="handleClick">
    <div class="dashboard-gauge" :style="{ width: `${size}px`, height: `${size}px` }">
      <canvas ref="canvas" :width="size" :height="size"></canvas>
    </div>
    <div class="dashboard-info">
      <div class="dashboard-title">
        <slot name="title">{{ title }}</slot>
      </div>
      <div class="dashboard-value">
        <slot name="value">{{ formattedValue }}</slot>
      </div>
    </div>
  </div>
</template>

<script>
import { getTheme, createRadialGradient, setGlowEffect, clearGlowEffect } from '../utils/themes'
import {
  drawCircle,
  drawRing,
  drawRadialLines,
  drawGlowBlocks,
  drawTicks,
  clearCanvas,
} from '../utils/canvas'

export default {
  name: 'DashboardGauge',

  props: {
    // 仪表盘标题
    title: {
      type: String,
      default: '',
    },

    // 仪表盘数值
    value: {
      type: [Number, String],
      default: 0,
    },

    // 主题颜色
    theme: {
      type: [String, Object],
      default: 'blue',
    },

    // 仪表盘尺寸
    size: {
      type: Number,
      default: 120,
    },

    // 是否启用动画
    animated: {
      type: Boolean,
      default: true,
    },

    // 动画速度
    speed: {
      type: Number,
      default: 1,
      validator: (value) => value >= 0.1 && value <= 5,
    },

    // 数值格式化函数
    valueFormatter: {
      type: Function,
      default: null,
    },

    // 最大值（用于计算高亮格数的比例）
    maxValue: {
      type: Number,
      default: 100,
    },

    // 格子总数
    segmentCount: {
      type: Number,
      default: 24,
    },
  },

  data() {
    return {
      ctx: null,
      animationId: null,
      rotation: 0,
      glowIntensity: 0.5,
      glowDirection: 1,
      // 用于存储上一次的值，用于动画过渡
      lastActiveSegments: 0,
    }
  },

  computed: {
    // 获取主题配置
    themeConfig() {
      return getTheme(this.theme)
    },

    // 格式化后的数值
    formattedValue() {
      if (this.valueFormatter) {
        return this.valueFormatter(this.value)
      }
      return this.value
    },

    // 中心点坐标
    center() {
      return this.size / 2
    },

    // 最大半径
    maxRadius() {
      return (this.size / 2) * 0.9
    },

    // 计算激活的格子数量
    activeSegments() {
      // 将字符串值转换为数字
      const numValue =
        typeof this.value === 'string'
          ? parseFloat(this.value.replace(/[^\d.-]/g, ''))
          : Number(this.value)

      // 计算激活的格子数量
      const ratio = Math.min(numValue / this.maxValue, 1)
      return Math.round(ratio * this.segmentCount)
    },
  },

  watch: {
    // 监听属性变化，重新渲染
    value() {
      this.render()
    },

    theme() {
      this.render()
    },

    size() {
      this.render()
    },

    animated(newVal) {
      if (newVal) {
        this.startAnimation()
      } else {
        this.stopAnimation()
      }
    },
  },

  mounted() {
    // 获取Canvas上下文
    this.ctx = this.$refs.canvas.getContext('2d')

    // 初始渲染
    this.render()

    // 如果启用动画，开始动画循环
    if (this.animated) {
      this.startAnimation()
    }
  },

  beforeUnmount() {
    // 组件销毁前停止动画
    this.stopAnimation()
  },

  methods: {
    /**
     * 渲染仪表盘
     */
    render() {
      const { ctx, center, maxRadius, themeConfig } = this

      // 清除画布
      clearCanvas(ctx, this.size, this.size)

      // 绘制背景圆
      drawCircle(ctx, center, center, maxRadius, themeConfig.background)

      // 绘制中心圆 - 使用更强的填充效果
      const centerRadius = maxRadius * 0.4
      drawCircle(
        ctx,
        center,
        center,
        centerRadius,
        createRadialGradient(
          ctx,
          center,
          center,
          centerRadius,
          themeConfig.primary,
          themeConfig.secondary
        )
      )

      // 绘制中间环
      const innerRadius = maxRadius * 0.4
      const outerRadius = maxRadius * 0.7

      drawRing(
        ctx,
        center,
        center,
        innerRadius,
        outerRadius,
        createRadialGradient(
          ctx,
          center,
          center,
          outerRadius,
          themeConfig.secondary,
          themeConfig.background
        )
      )

      // 保存当前状态
      ctx.save()

      // 应用旋转动画
      if (this.animated) {
        ctx.translate(center, center)
        ctx.rotate(this.rotation)
        ctx.translate(-center, -center)
      }

      // 绘制放射状线条
      const linesCount = 24
      drawRadialLines(
        ctx,
        center,
        center,
        innerRadius,
        outerRadius,
        linesCount,
        themeConfig.primary,
        1
      )

      // 恢复状态
      ctx.restore()

      // 保存状态用于外环动画
      ctx.save()

      // 应用外环旋转动画（反向旋转）
      if (this.animated) {
        ctx.translate(center, center)
        ctx.rotate(-this.rotation * 0.5)
        ctx.translate(-center, -center)
      }

      // 绘制外环发光块
      const blocksCount = this.segmentCount
      const blockWidth = Math.PI / 24

      // 创建未激活格子的颜色（半透明）
      const inactiveColor = `rgba(${parseInt(themeConfig.secondary.slice(1, 3), 16)}, 
                                  ${parseInt(themeConfig.secondary.slice(3, 5), 16)}, 
                                  ${parseInt(themeConfig.secondary.slice(5, 7), 16)}, 0.3)`

      setGlowEffect(ctx, themeConfig.glow, 10 * this.glowIntensity)
      drawGlowBlocks(
        ctx,
        center,
        center,
        maxRadius * 0.85,
        blocksCount,
        blockWidth,
        themeConfig.primary,
        inactiveColor,
        this.activeSegments
      )
      clearGlowEffect(ctx)

      // 绘制外环刻度
      drawTicks(ctx, center, center, maxRadius * 0.75, 48, 5, themeConfig.primary, 1)

      // 恢复状态
      ctx.restore()

      // 添加整体发光效果
      if (this.animated) {
        ctx.save()
        setGlowEffect(ctx, themeConfig.glow, 5 * this.glowIntensity)
        drawCircle(ctx, center, center, maxRadius * 0.9, null, themeConfig.primary, 0.5)
        clearGlowEffect(ctx)
        ctx.restore()
      }
    },

    /**
     * 开始动画循环
     */
    startAnimation() {
      if (this.animationId) return

      const animate = () => {
        // 旋转角度
        this.rotation += 0.005 * this.speed
        if (this.rotation >= Math.PI * 2) {
          this.rotation = 0
        }

        // 发光强度
        this.glowIntensity += 0.01 * this.glowDirection * this.speed
        if (this.glowIntensity >= 1) {
          this.glowIntensity = 1
          this.glowDirection = -1
        } else if (this.glowIntensity <= 0.5) {
          this.glowIntensity = 0.5
          this.glowDirection = 1
        }

        // 重新渲染
        this.render()

        // 继续下一帧
        this.animationId = requestAnimationFrame(animate)
      }

      this.animationId = requestAnimationFrame(animate)
    },

    /**
     * 停止动画循环
     */
    stopAnimation() {
      if (this.animationId) {
        cancelAnimationFrame(this.animationId)
        this.animationId = null
      }
    },

    /**
     * 处理点击事件
     */
    handleClick(event) {
      this.$emit('click', event)
    },

    /**
     * 设置主题
     */
    setTheme(theme) {
      this.$emit('update:theme', theme)
    },

    /**
     * 设置数值
     */
    setValue(value) {
      const oldValue = this.value
      this.$emit('update:value', value)
      this.$emit('value-change', value, oldValue)
    },

    /**
     * 切换动画状态
     */
    toggleAnimation(status) {
      this.$emit('update:animated', status)
    },
  },
}
</script>

<style scoped>
.dashboard-gauge-container {
  display: flex;
  flex-direction: row;
  align-items: center;
  margin: 0 auto;
}

.dashboard-gauge {
  position: relative;
  display: inline-block;
}
.dashboard-info {
  min-width: 90px;
}

.dashboard-title {
  font-size: 14px;
  margin-bottom: 5px;
  color: v-bind('themeConfig.textPrimary');
  text-align: center;
}

.dashboard-value {
  font-size: 28px;
  font-weight: bold;
  margin-top: 5px;
  color: v-bind('themeConfig.textPrimary');
  text-align: center;
}

@media (max-width: 768px) {
  .dashboard-title {
    font-size: 12px;
  }

  .dashboard-value {
    font-size: 24px;
  }
}
</style>
