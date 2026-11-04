# -*- coding: utf-8 -*-
"""重绘图1 v5「平台总体架构与数据流」（美观迭代版）

相对 v3 的设计调整（只动视觉，不动任何技术内容）：
 1) 删除贯穿全图的两条长箭头（观感似"边框线"，用户反馈不美观）；
 2) 层间间隙由 21px 放宽到 30px、色带高 116→109（总高不变，版面比例不变）；
 3) 每个层间画一对短双箭头：蓝↑=监测数据上行、橙↓=授权指令下行
    （替换原来的"单灰线+横档"，与层间标签同一视觉系统）；
 4) 顶部加一行小图例："↑ 监测数据上行  ↓ 授权指令下行"（蓝/橙分色）。
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

# 色带高 109、层间间隙 28；顶部留白 25px（v5：修复顶部图例挤压），底部 17px，总高不变
BAND_Y = [(25, 134), (162, 271), (299, 408), (436, 545), (573, 682)]
INSET = 13
XB0, XB1 = 15, 1249              # 色带左右边
XLAB = 111                       # 层名中心
XO0, XO1 = 208, 1233             # 内容框左右边
X3 = [208, 539, 556, 886, 903, 1233]
XC = 721.5                       # 层间箭头对中轴
XCT = 741                        # 连接标签左边界

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

# 层间连接：上行（蓝 ↑）/ 下行（橙 ↓）双箭头对 + 内容标签
for i in range(4):
    ytop = BAND_Y[i][1] + 1
    ybot = BAND_Y[i + 1][0] - 1
    ya, yb = ytop + 2, ybot - 2          # 箭头两端留余量
    # 上行：监测数据（蓝，尖朝上）
    ax.annotate("", xy=(XC - 7, ya), xytext=(XC - 7, yb),
                arrowprops=dict(arrowstyle="-|>", color="#1f4e79", lw=1.8,
                                mutation_scale=11, shrinkA=0, shrinkB=0), zorder=5)
    # 下行：授权指令（橙，尖朝下）
    ax.annotate("", xy=(XC + 7, yb), xytext=(XC + 7, ya),
                arrowprops=dict(arrowstyle="-|>", color="#c06810", lw=1.8,
                                mutation_scale=11, shrinkA=0, shrinkB=0), zorder=5)
    ax.text(XCT, (ytop + ybot) / 2, CONN[i], ha="left", va="center",
            fontsize=11.5, color="#4d4d4d", zorder=6,
            bbox=dict(fc="white", ec="none", pad=1.2))

# 顶部图例（箭头含义，蓝/橙分色）
ax.text(600, 12, "↑ 监测数据上行", ha="right", va="center",
        fontsize=10, color="#1f4e79", zorder=6)
ax.text(664, 12, "↓ 授权指令下行", ha="left", va="center",
        fontsize=10, color="#c06810", zorder=6)

out = r"D:/驭弓大师/10_创新升级/fig1_arch_v5.png"
plt.savefig(out, facecolor="white")
plt.close(fig)
print("saved:", out)
