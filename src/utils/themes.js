/**
 * 仪表盘组件主题配置
 */

// 预定义主题颜色
export const THEMES = {
  // 蓝色主题 - 投运车辆
  blue: {
    primary: '#4A9FFF',
    secondary: '#1E4C8A',
    background: '#0A1A3A',
    glow: 'rgba(74, 159, 255, 0.8)',
    textPrimary: '#4A9FFF',
    textSecondary: '#FFFFFF'
  },
  // 青色主题 - 运营车辆
  cyan: {
    primary: '#00E4FF',
    secondary: '#00809F',
    background: '#0A1A3A',
    glow: 'rgba(0, 228, 255, 0.8)',
    textPrimary: '#00E4FF',
    textSecondary: '#FFFFFF'
  },
  // 紫色主题 - 非运营车辆
  purple: {
    primary: '#C76BFF',
    secondary: '#6A2E8A',
    background: '#0A1A3A',
    glow: 'rgba(199, 107, 255, 0.8)',
    textPrimary: '#C76BFF',
    textSecondary: '#FFFFFF'
  },
  // 浅紫色主题 - 故障告警车辆
  lightPurple: {
    primary: '#A48FFF',
    secondary: '#5A4A8A',
    background: '#0A1A3A',
    glow: 'rgba(164, 143, 255, 0.8)',
    textPrimary: '#A48FFF',
    textSecondary: '#FFFFFF'
  },
  // 橙色主题 - 乘车率
  orange: {
    primary: '#FFA64A',
    secondary: '#8A5A2E',
    background: '#0A1A3A',
    glow: 'rgba(255, 166, 74, 0.8)',
    textPrimary: '#FFA64A',
    textSecondary: '#FFFFFF'
  }
};

/**
 * 获取主题配置
 * @param {String|Object} theme 主题名称或自定义主题对象
 * @returns {Object} 主题配置对象
 */
export function getTheme (theme) {
  // 如果是字符串，则从预定义主题中获取
  if (typeof theme === 'string') {
    return THEMES[theme] || THEMES.blue;
  }

  // 如果是对象，则合并默认主题
  if (typeof theme === 'object' && theme !== null) {
    return {
      ...THEMES.blue,
      ...theme
    };
  }

  // 默认返回蓝色主题
  return THEMES.blue;
}

/**
 * 创建渐变色
 * @param {CanvasRenderingContext2D} ctx Canvas上下文
 * @param {Number} x 中心点x坐标
 * @param {Number} y 中心点y坐标
 * @param {Number} radius 半径
 * @param {String} color1 内部颜色
 * @param {String} color2 外部颜色
 * @returns {CanvasGradient} 渐变对象
 */
export function createRadialGradient (ctx, x, y, radius, color1, color2) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, color1);
  gradient.addColorStop(1, color2);
  return gradient;
}

/**
 * 创建发光效果
 * @param {CanvasRenderingContext2D} ctx Canvas上下文
 * @param {String} color 发光颜色
 * @param {Number} blur 模糊程度
 * @returns {void}
 */
export function setGlowEffect (ctx, color, blur = 15) {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

/**
 * 清除发光效果
 * @param {CanvasRenderingContext2D} ctx Canvas上下文
 * @returns {void}
 */
export function clearGlowEffect (ctx) {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}
