/**
 * Canvas绘制工具函数
 */

/**
 * 绘制圆形
 * @param {CanvasRenderingContext2D} ctx Canvas上下文
 * @param {Number} x 中心点x坐标
 * @param {Number} y 中心点y坐标
 * @param {Number} radius 半径
 * @param {String|CanvasGradient} fillStyle 填充样式
 * @param {String|CanvasGradient} strokeStyle 描边样式
 * @param {Number} lineWidth 线宽
 */
export function drawCircle (ctx, x, y, radius, fillStyle = null, strokeStyle = null, lineWidth = 1) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2, false);

  if (fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }

  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

/**
 * 绘制环形
 * @param {CanvasRenderingContext2D} ctx Canvas上下文
 * @param {Number} x 中心点x坐标
 * @param {Number} y 中心点y坐标
 * @param {Number} innerRadius 内半径
 * @param {Number} outerRadius 外半径
 * @param {String|CanvasGradient} fillStyle 填充样式
 * @param {String|CanvasGradient} strokeStyle 描边样式
 * @param {Number} lineWidth 线宽
 */
export function drawRing (ctx, x, y, innerRadius, outerRadius, fillStyle = null, strokeStyle = null, lineWidth = 1) {
  ctx.beginPath();
  // 绘制外圆
  ctx.arc(x, y, outerRadius, 0, Math.PI * 2, false);
  // 绘制内圆（逆时针方向，形成挖空效果）
  ctx.arc(x, y, innerRadius, 0, Math.PI * 2, true);

  if (fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }

  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

/**
 * 绘制放射状线条
 * @param {CanvasRenderingContext2D} ctx Canvas上下文
 * @param {Number} x 中心点x坐标
 * @param {Number} y 中心点y坐标
 * @param {Number} innerRadius 内半径
 * @param {Number} outerRadius 外半径
 * @param {Number} count 线条数量
 * @param {String} strokeStyle 描边样式
 * @param {Number} lineWidth 线宽
 */
export function drawRadialLines (ctx, x, y, innerRadius, outerRadius, count, strokeStyle, lineWidth = 3) {
  const angleStep = (Math.PI * 2) / count;

  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;

  for (let i = 0;i < count;i++) {
    const angle = i * angleStep;
    const innerX = x + innerRadius * Math.cos(angle);
    const innerY = y + innerRadius * Math.sin(angle);
    const outerX = x + outerRadius * Math.cos(angle);
    const outerY = y + outerRadius * Math.sin(angle);

    ctx.beginPath();
    ctx.moveTo(innerX, innerY);
    ctx.lineTo(outerX, outerY);
    ctx.stroke();
  }
}

/**
 * 绘制外环发光块
 * @param {CanvasRenderingContext2D} ctx Canvas上下文
 * @param {Number} x 中心点x坐标
 * @param {Number} y 中心点y坐标
 * @param {Number} radius 半径
 * @param {Number} count 发光块数量
 * @param {Number} blockWidth 发光块宽度（弧度）
 * @param {String} fillStyle 填充样式
 * @param {String} inactiveFillStyle 未激活的填充样式
 * @param {Number} activeCount 激活的发光块数量
 */
export function drawGlowBlocks (ctx, x, y, radius, count, blockWidth, fillStyle, inactiveFillStyle, activeCount) {
  const angleStep = (Math.PI * 2) / count;

  for (let i = 0;i < count;i++) {
    // 确定当前块是否激活
    const isActive = i < activeCount;

    // 设置填充样式
    ctx.fillStyle = isActive ? fillStyle : inactiveFillStyle;

    const startAngle = i * angleStep - blockWidth / 2;
    const endAngle = startAngle + blockWidth;

    // 增大发光块的尺寸
    ctx.beginPath();
    ctx.arc(x, y, radius, startAngle, endAngle, false);
    ctx.arc(x, y, radius - 10, endAngle, startAngle, true);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * 绘制仪表盘刻度
 * @param {CanvasRenderingContext2D} ctx Canvas上下文
 * @param {Number} x 中心点x坐标
 * @param {Number} y 中心点y坐标
 * @param {Number} radius 半径
 * @param {Number} count 刻度数量
 * @param {Number} length 刻度长度
 * @param {String} strokeStyle 描边样式
 * @param {Number} lineWidth 线宽
 */
export function drawTicks (ctx, x, y, radius, count, length, strokeStyle, lineWidth = 1) {
  const angleStep = (Math.PI * 2) / count;

  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;

  for (let i = 0;i < count;i++) {
    const angle = i * angleStep;
    const innerRadius = radius - length;

    const innerX = x + innerRadius * Math.cos(angle);
    const innerY = y + innerRadius * Math.sin(angle);
    const outerX = x + radius * Math.cos(angle);
    const outerY = y + radius * Math.sin(angle);

    ctx.beginPath();
    ctx.moveTo(innerX, innerY);
    ctx.lineTo(outerX, outerY);
    ctx.stroke();
  }
}

/**
 * 清除Canvas
 * @param {CanvasRenderingContext2D} ctx Canvas上下文
 * @param {Number} width 宽度
 * @param {Number} height 高度
 */
export function clearCanvas (ctx, width, height) {
  ctx.clearRect(0, 0, width, height);
}
