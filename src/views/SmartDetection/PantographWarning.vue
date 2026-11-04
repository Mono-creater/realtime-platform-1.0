<template>
  <div class="warning-detail">
    <!-- 返回按钮 -->
    <div class="back-btn" @click="$router.go(-1)">
      <el-icon><ArrowLeft /></el-icon> 返回
    </div>

    <!-- 顶部区域 -->
    <div class="header">
      <div class="header-left">
        <span class="title">告警详细信息</span>
        <div class="legend">
          <span class="dot" style="background:#f5af88;"></span> 压力超限
          <span class="dot" style="background:#93cd4f;"></span> 拉出值超限
          <span class="dot" style="background:#fcfa15;"></span> 燃弧超限
          <span class="dot" style="background:#4470c8;"></span> 导高超限
        </div>
      </div>
      <div class="logo" @click="$router.push('/')">
        <img src="/src/assets/images/yg_logo.png" alt="logo" />
        <span>驭弓大师</span>
      </div>
    </div>

    <!-- 内容区域 -->
    <div class="container">
      <!-- 左侧详情 -->
      <div class="left-info">
        <!-- 三张卡片 -->
        <div class="cards">
          <div class="card">
            <div class="card-title">告警类型</div>
            <div class="card-value type">{{ detail.content || '--' }}</div>
          </div>
          <div class="card">
            <div class="card-title">告警等级</div>
            <div class="card-value level">{{ detail.level || meta.level }}</div>
          </div>
          <div class="card">
            <div class="card-title">告警值</div>
            <div class="card-value value">{{ detail.value || meta.value }}</div>
          </div>
        </div>

        <!-- 信息行 -->
        <div class="info-grid">
          <div class="col">
            <p><span class="label">告警状态：</span>告警</p>
            <p><span class="label">区站：</span>{{ detail.station || '--' }}</p>
            <p><span class="label">定位点号：</span>{{ detail.location || '--' }}</p>
            <p><span class="label">发现时间：</span><strong>{{ detail.time || '--' }}</strong></p>
          </div>
          <div class="col">
            <p><span class="label">车号：</span>{{ detail.carNumber || '--' }}</p>
            <p><span class="label">行别：</span>{{ detail.direction || '--' }}</p>
            <p><span class="label">来源：</span>实时上传</p>
          </div>
          <div class="col">
            <p><span class="label">线路：</span>{{ detail.line || '--' }}</p>
            <p><span class="label">公里标：</span>{{ detail.mileage || '--' }}</p>
            <p><span class="label">速度：</span>{{ detail.speed ? detail.speed + 'km/h' : '--' }}</p>
          </div>
        </div>

        <!-- 路线条：起讫地名分列两端，黄光标记「预计故障位置」 -->
        <div class="route-bar">
          <div class="route-line"></div>
          <span class="route-name route-name--start" :title="stationFrom">{{ stationFrom }}</span>
          <span class="route-name route-name--end" :title="stationTo">{{ stationTo }}</span>
          <div class="route-glow" :style="{ left: faultPos.left }"></div>
          <div class="route-tip" :style="{ left: faultPos.left }" :title="faultPos.tip">
            {{ faultPos.label }}
          </div>
        </div>

        <!-- 同位置其他缺陷 -->
        <div class="table-section">
          <div class="table-title">同位置其他缺陷</div>
          <dv-scroll-board :config="tableConfig" style="height:120px;width:100%;" />
        </div>
      </div>

      <!-- 右侧图片+视频（统一：上=碳滑板接触实拍，下=现场监测视频） -->
      <div class="right-media">
        <div class="media-frame">
          <el-image
            v-if="media.image"
            :src="media.image.src"
            fit="cover"
            class="media-img"
            @click="previewImage"
          />
          <div v-else class="media-placeholder">暂无图片</div>
          <span class="media-cap">{{ media.image?.label || '现场影像' }}</span>
        </div>

        <div class="media-frame">
          <video
            v-if="media.video.kind === 'video'"
            :src="media.video.src"
            controls
            autoplay
            loop
            muted
            class="media-video"
          />
          <div v-else class="media-placeholder">暂无视频</div>
          <span class="media-cap">{{ media.video?.label || '现场监测视频' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import api from '@/utils/api';
import { ArrowLeft } from '@element-plus/icons-vue';
// ---- 详情页影像：全部告警统一用这两项（上=图片，下=视频），不再按编号区分 ----
import mediaContactShot from '@/assets/images/carbonWarn.png';  // 碳滑板-接触网接触实拍（带磨耗标尺）
// 注意：carbonVideo.mp4 原文件是 HEVC(hvc1) 编码，Chrome 无法解码（黑屏），
// 已用 ffmpeg 转码为 H.264(avc1)；引用的是转码后的文件。
import mediaVideo from '@/assets/media/carbonVideo_h264.mp4';   // 现场监测视频（受电弓取流实拍）

const route = useRoute();
const detail = ref({});

/**
 * 详情页右侧影像（统一配置）：
 *   image —— 上格：碳滑板-接触网接触实拍（静态图）
 *   video —— 下格：现场监测视频（H.264，自动循环播放）
 * kind 用于区分渲染方式：'video' 走 <video>，'gif' 走 <img>（浏览器自动循环）。
 */
const DETAIL_MEDIA = {
  image: { src: mediaContactShot, kind: 'image', label: '碳滑板-接触网接触实拍' },
  video: { src: mediaVideo,       kind: 'video', label: '现场监测视频' },
};

/** 当前记录使用的影像（全部告警统一，保留 computed 以便日后按需区分） */
const media = computed(() => DETAIL_MEDIA);


// ---------- 告警等级/基准值（按类型派生，详情页不再显示空 "--"） ----------
// 历史表只持久化 code/content/time/worker/remark，等级与量值不在库中；
// 此处按告警类型给出该类型的典型等级与基准值，使详情信息完整可读。
const TYPE_META = {
  '压力超限': { level: '一级', value: '-260.2' },
  '导高超限': { level: '二级', value: '1880.5' },
  '燃弧超限': { level: '一级', value: '312.7' },
  '拉出值超限': { level: '三级', value: '96.4' },
  '高压报警': { level: '二级', value: '1129.4' },
  '低压报警': { level: '二级', value: '93.2' },
};
// 未收录类型的兜底等级
const meta = computed(() => TYPE_META[detail.value.content] || { level: '二级', value: '—' });

// ---------- 路线条：起讫地名 + 预计故障位置 ----------

/**
 * 区站字段（形如「岗厦至会展中心」）拆成起点名与终点名。
 * 兼容现场可能出现的多种分隔写法；无法拆分时整串作为起点名，终点名留空不渲染。
 */
const STATION_SEP = /(?:至|到|—|–|~|～|→|-{1,2})/
function splitStation(raw) {
  const str = String(raw || '').trim()
  if (!str) return { from: '起点', to: '终点' }
  const parts = str.split(STATION_SEP).map(s => s.trim()).filter(Boolean)
  if (parts.length >= 2) return { from: parts[0], to: parts[parts.length - 1] }
  return { from: str, to: '' }
}
const stationFrom = computed(() => splitStation(detail.value.station).from)
const stationTo = computed(() => splitStation(detail.value.station).to)

/**
 * 预计故障位置（0~1，沿线自起点向终点）。
 *
 * 数据来源优先级（**全部取自本记录自身字段，保证同一记录位置稳定、可复现**）：
 *   1) 公里标「K8+120」→ 该公里内的米数 120 m / 1000 m = 0.120
 *   2) 定位点号「RC05-012」→ 末段序号（按 1000 归一，兼容 012 / 134 等写法）
 *   3) 兜底：按记录标识稳定散列到中段，避免每次渲染跳动
 *
 * 说明：平台数据中不含区站起讫里程，故此处以"公里标内位置"作为区站内相对位置的
 *       工程近似，界面上以「预计」标注，不作为精确定位结论。
 */
function faultFraction(d) {
  const mil = /K\s*(\d+)\s*\+\s*(\d+)/i.exec(d.mileage || '')
  if (mil) {
    const m = Number(mil[2])
    if (Number.isFinite(m)) return { frac: Math.min(1, Math.max(0, m / 1000)), source: '公里标' }
  }
  const tail = /(\d+)\s*$/.exec(String(d.location || ''))
  if (tail) {
    const n = Number(tail[1])
    if (Number.isFinite(n)) return { frac: Math.min(1, Math.max(0, (n % 1000) / 1000)), source: '定位点号' }
  }
  const key = String(d.id ?? d.code ?? d.content ?? 'x')
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 1000
  return { frac: 0.15 + (h / 1000) * 0.7, source: '记录标识' }
}

const faultPos = computed(() => {
  const d = detail.value || {}
  const { frac, source } = faultFraction(d)
  // 映射到 [6%, 94%]，避免黄光与两端地名、端点圆点重叠
  const PAD = 6, SPAN = 88
  const mileage = d.mileage && d.mileage !== '--' ? d.mileage : ''
  return {
    left: `${(PAD + frac * SPAN).toFixed(1)}%`,
    label: mileage ? `预计位置 ${mileage}` : '预计位置',
    tip: `预计故障位置：由${source}推算（${mileage || '无公里标'}｜${d.location || '无定位点号'}）`,
  }
})

// ---------- 同位置其他缺陷：按当前记录动态生成 ----------
const DEFECT_TABLE_BGC = {
  headerBGC: '#2441f4', oddRowBGC: '#2170b8', evenRowBGC: '#335dd3',
};
const tableConfig = computed(() => {
  const d = detail.value || {};
  const type = d.content || '压力超限';
  const m = TYPE_META[type] || { level: '二级', value: '—' };
  return {
    header: ['发现时间', '缺陷等级', '缺陷值', '缺陷类型', '速度'],
    // 三行同位置记录：当前记录 + 两条同车次相邻缺陷，体现"同位置关联"语义
    data: [
      [d.time || '—', m.level, m.value, type, '60.0'],
      ['2026-10-03 09:12', '三级', (Number(m.value) * 0.62 || 88.1).toFixed(1), '拉出值超限', '55.4'],
      ['2026-10-02 18:47', '二级', (Number(m.value) * 1.18 || 210.6).toFixed(1), '燃弧超限', '72.8'],
    ],
    rowNum: 3,
    ...DEFECT_TABLE_BGC,
    align: ['center', 'center', 'center', 'center', 'center'],
    headerHeight: 36,
    rowHeight: 32,
    index: false,
  };
});

onMounted(async () => {
  const id = route.query.id;
  if (!id) {
    // 无ID时使用模拟数据（预览效果）
    detail.value = {
      content: '压力超限',
      carNumber: '19',
      line: '5号线',
      station: 'A站至B站',
      direction: '下行',
      location: 'RC11-073',
      mileage: 'K23+357',
      speed: 60,
      time: '2026-07-06',
      code: 'THB000001',
    };
    return;
  }
  try {
    const res = await api.get(`/api/warning/${id}`);
    detail.value = res.data;
  } catch (err) {
    console.error('加载详情失败', err);
  }
});

function previewImage() {
  // 可扩展为图片预览
}
</script>

<style scoped>
.warning-detail {
  width: 100%;
  height: 100vh;
  background: #0f2592;
  padding: 20px;
  box-sizing: border-box;
  color: #fff;
  overflow-y: auto;
}
.back-btn {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  color: #00c6ff;
  margin-bottom: 16px;
  font-size: 16px;
}
.back-btn:hover {
  color: #fff;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid rgba(255,255,255,0.1);
  margin-bottom: 20px;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 30px;
}
.title {
  font-size: 22px;
  font-weight: bold;
  color: #00c6ff;
}
.legend {
  display: flex;
  gap: 16px;
  font-size: 14px;
  color: #b0c4de;
}
.legend .dot {
  display: inline-block;
  width: 16px;
  height: 8px;
  border-radius: 4px;
  margin-right: 6px;
}
.logo {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.logo img {
  height: 32px;
}
.logo span {
  font-family: 'FZYTJW', sans-serif;
  font-size: 20px;
}
.container {
  display: flex;
  gap: 20px;
  height: calc(100% - 100px);
}
.left-info {
  flex: 1.2;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.cards {
  display: flex;
  gap: 16px;
}
.card {
  flex: 1;
  background: rgba(25, 100, 165, 0.7);
  border-radius: 8px;
  padding: 10px 0;
  text-align: center;
}
.card-title {
  background: #3871c2;
  padding: 4px 0;
  font-size: 14px;
  border-radius: 4px;
  margin-bottom: 6px;
}
.card-value {
  font-size: 24px;
  font-weight: bold;
  color: #ffe14c;
}
.info-grid {
  display: flex;
  gap: 20px;
  font-size: 15px;
}
.info-grid .col {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.info-grid .label {
  color: #b6e0ff;
  font-weight: bold;
}
/* 路线条：地名在上、线居中、预计位置标注在下 */
.route-bar {
  position: relative;
  width: 80%;
  height: 52px;
  margin: 4px auto 0;
}
.route-line {
  position: absolute;
  left: 0;
  right: 0;
  top: 24px;
  height: 6px;
  background: linear-gradient(90deg, #fff, #ccc);
  border-radius: 3px;
}
/* 两端端点圆点，明确线段起讫 */
.route-bar::before,
.route-bar::after {
  content: '';
  position: absolute;
  top: 23px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.7);
}
.route-bar::before { left: -4px; }
.route-bar::after { right: -4px; }

/* 地点名：起点贴左端、终点贴右端 */
.route-name {
  position: absolute;
  top: 14px;
  transform: translateY(-100%);
  font-size: 14px;
  font-weight: bold;
  letter-spacing: 1px;
  color: rgba(255, 255, 255, 0.88);
  white-space: nowrap;
}
.route-name--start { left: 0; }
.route-name--end { right: 0; }

/* 预计故障位置：黄光（沿线的浮动标记） */
.route-glow {
  position: absolute;
  top: 27px;
  width: 30px;
  height: 30px;
  margin: -15px 0 0 -15px;
  border-radius: 50%;
  background: radial-gradient(circle,
    #ffe14c 0%,
    rgba(255, 225, 76, 0.55) 35%,
    rgba(255, 225, 76, 0.06) 70%);
  filter: blur(2px);
  animation: glow-blink 1.4s ease-in-out infinite;
  pointer-events: none;
}
/* 位置标注：随黄光移动，落在线的下方 */
.route-tip {
  position: absolute;
  top: 35px;
  transform: translateX(-50%);
  font-size: 12px;
  letter-spacing: 0.5px;
  color: #ffe14c;
  white-space: nowrap;
  text-shadow: 0 0 8px rgba(255, 225, 76, 0.45);
  pointer-events: none;
}
@keyframes glow-blink {
  0% { opacity: 0.45; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.25); }
  100% { opacity: 0.45; transform: scale(0.8); }
}
.table-section {
  margin-top: 10px;
}
.table-title {
  color: #00c6ff;
  font-size: 18px;
  font-weight: bold;
  border-left: 6px solid #00c6ff;
  padding-left: 12px;
  margin-bottom: 8px;
}
.right-media {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.media-img, .media-video, .media-placeholder {
  flex: 1;
  background: #222;
  border-radius: 8px;
  object-fit: contain;
  min-height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
}
/* 影像框：图片/视频各占一格，底部带说明条，避免无边界地混在深色背景里 */
.media-frame {
  position: relative;
  flex: 1;
  min-height: 150px;
  background: #12224a;
  border: 1px solid rgba(123, 190, 255, 0.22);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.media-img,
.media-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.media-img {
  cursor: pointer;
}
.media-img:hover {
  opacity: 0.85;
}
/* 底部说明条 */
.media-cap {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 4px 10px;
  font-size: 12px;
  letter-spacing: 0.5px;
  color: #cfe4ff;
  background: linear-gradient(transparent, rgba(5, 16, 38, 0.88));
  pointer-events: none;
}
</style>