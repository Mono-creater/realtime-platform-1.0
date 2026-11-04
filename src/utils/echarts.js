// ECharts 按需引入（替代 `import * as echarts from 'echarts'` 全量引入）
// 本项目用折线图 + 饼图 + 雷达图 + 柱状图（Pareto/分级）+ 散点图（磨耗预测）
import * as echarts from 'echarts/core'
import { LineChart, PieChart, RadarChart, BarChart, ScatterChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AxisPointerComponent,
  RadarComponent,
  MarkLineComponent,
  MarkPointComponent,
  GraphicComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart,
  PieChart,
  RadarChart,
  BarChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AxisPointerComponent,
  RadarComponent,
  MarkLineComponent,
  MarkPointComponent,
  GraphicComponent,
  CanvasRenderer,
])

export default echarts
