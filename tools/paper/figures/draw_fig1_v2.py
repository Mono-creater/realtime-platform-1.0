# -*- coding: utf-8 -*-
"""重绘图1「平台总体架构与数据流」（高分辨率投稿版）

坐标体系：直接沿用原图的 1265×699 像素坐标系（x 右、y 下），
         由 add_axes([0,0,1,1]) + 反转 y 轴实现 1:1 复刻。
版式：画布宽 9.6 in，论文中显示宽 14.60 cm（缩放 0.5988）；
     字号 ≥ 11.5 pt 保证印刷 ≥ 6.9 pt。
配色取自原图采样：蓝 #1f4e79 / 青 #17696a / 橙 #c06810 / 绿 #276b38 / 紫 #56367a
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
from matplotlib import font_manager

for f in ["Microsoft YaHei", "SimHei"]:
    try:
        font_manager.findfont(f, fallback_to_default=False)
        plt.rcParams["font.sans-serif"] = [f]
        break
    except Exception:
        continue
plt.rcParams["axes.unicode_minus"] = False

W_PX, H_PX = 1265, 699
FIG_W = 9.6
fig = plt.figure(figsize=(FIG_W, FIG_W * H_PX / W_PX), dpi=300)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, W_PX); ax.set_ylim(H_PX, 0)
ax.axis("off")

BANDS = [
    ("端侧感知层", "#e4ecf5", "#1f4e79",
     ["4~20 mA 变送器 → GL10-4AD（温度 / 压力 / 湿度）"]),
    ("边缘判阈层", "#e0f0f0", "#17696a",
     ["100 ms 采样", "10 点滑窗均值", "分级判阈 + 报文组帧"]),
    ("通信协议层", "#fbeedd", "#c06810",
     ["Modbus TCP FC03 / FC16", "主包 2001—2005", "异常子包 2011—2015"]),
    ("平台服务层", "#e4f1e7", "#276b38",
     ["报文解析 + 数据质量码", "告警引擎（双判据）", "链路监测 / 推送 / 审计"]),
    ("运维闭环层", "#eee8f4", "#56367a",
     ["告警与样本落库", "工单状态机", "健康指数 / MTTR / KPI"]),
]
CONN = ["4~20 mA", "Modbus TCP", "报文/告警", "落库/工单"]

BAND_Y = [(17, 133), (154, 270), (291, 407), (428, 544), (565, 682)]
INSET = 13
XB0, XB1 = 15, 1249              # 色带左右边
XLAB = 111                       # 层名中心
XO0, XO1 = 208, 1233             # 内容框左右边
X3 = [208, 539, 556, 886, 903, 1233]
XC = 721.5                       # 连接线
XCT = 741                        # 连接线标签左边界

for i, ((y0, y1), (lab, fill, edge, boxes)) in enumerate(zip(BAND_Y, BANDS)):
    # 色带
    ax.add_patch(FancyBboxPatch((XB0, y0), XB1 - XB0, y1 - y0,
                                boxstyle="round,pad=0,rounding_size=9",
                                fc=fill, ec=edge, lw=1.0, zorder=2))
    # 层名
    ax.text(XLAB, (y0 + y1) / 2, lab, ha="center", va="center",
            fontsize=12.5, color=edge, zorder=4)
    # 内容框
    by0, by1 = y0 + INSET, y1 - INSET
    if len(boxes) == 1:
        ax.add_patch(FancyBboxPatch((XO0, by0), XO1 - XO0, by1 - by0,
                                    boxstyle="round,pad=0,rounding_size=7",
                                    fc="white", ec=edge, lw=0.9, zorder=3))
        ax.text((XO0 + XO1) / 2, (by0 + by1) / 2, boxes[0], ha="center",
                va="center", fontsize=12, color="#1a1a1a", zorder=4)
    else:
        for a, b, t in zip(X3[0::2], X3[1::2], boxes):
            ax.add_patch(FancyBboxPatch((a, by0), b - a, by1 - by0,
                                        boxstyle="round,pad=0,rounding_size=7",
                                        fc="white", ec=edge, lw=0.9, zorder=3))
            ax.text((a + b) / 2, (by0 + by1) / 2, t, ha="center",
                    va="center", fontsize=12, color="#1a1a1a", zorder=4)

# 波段间连接线与标签
for i in range(4):
    ytop = BAND_Y[i][1] + 1
    ybot = BAND_Y[i + 1][0] - 1
    ax.plot([XC, XC], [ytop, ybot], color="#7a7a7a", lw=0.9, zorder=5,
            solid_capstyle="butt")
    for yy in (ytop, ybot):          # 端部小横档
        ax.plot([XC - 5, XC + 5], [yy, yy], color="#7a7a7a", lw=0.9, zorder=5)
    ax.text(XCT, (ytop + ybot) / 2, CONN[i], ha="left", va="center",
            fontsize=11.5, color="#4d4d4d", zorder=6,
            bbox=dict(fc="white", ec="none", pad=1.2))

out = r"D:/驭弓大师/10_创新升级/fig1_arch_v2.png"
plt.savefig(out, facecolor="white")
plt.close(fig)
print("saved:", out)
