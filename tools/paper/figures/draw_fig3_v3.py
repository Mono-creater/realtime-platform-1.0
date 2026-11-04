# -*- coding: utf-8 -*-
"""重绘图3：告警引擎处理链（统一阈值通道口径为"EWMA 平滑值 + 连续2点确认"）"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from matplotlib import font_manager

# 中文字体
for f in ["Microsoft YaHei", "SimHei", "PingFang SC", "Noto Sans CJK SC"]:
    try:
        font_manager.findfont(f, fallback_to_default=False)
        plt.rcParams["font.sans-serif"] = [f]
        break
    except Exception:
        continue
plt.rcParams["axes.unicode_minus"] = False

fig, ax = plt.subplots(figsize=(11, 4.2), dpi=200)
ax.set_xlim(0, 22); ax.set_ylim(0, 9); ax.axis("off")

def box(x, y, w, h, text, fc, ec, fs=11, bold=False):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.12,rounding_size=0.18",
                                fc=fc, ec=ec, lw=1.6))
    ax.text(x + w/2, y + h/2, text, ha="center", va="center", fontsize=fs,
            fontweight="bold" if bold else "normal", color="#1f2937", linespacing=1.4)

def arrow(x1, y1, x2, y2, color="#6b7280", lw=1.6):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>",
                                 mutation_scale=13, color=color, lw=lw,
                                 shrinkA=1, shrinkB=1))

# 顶部要点
ax.text(0.2, 8.5, "要点：变化率通道须与阈值通道共用同一滤波序列，否则中值滤波对缓变判据失效；",
        fontsize=10.5, color="#111827")
ax.text(0.2, 8.05, "本文改用 EWMA 平滑＋滑动窗最小二乘斜率统一滤波，从根源消除不一致并给出理论控制限。",
        fontsize=10.5, color="#111827")

# 主干链
box(0.2, 5.6, 3.4, 1.5, "采样序列", "#eef2ff", "#818cf8")
box(4.4, 5.6, 3.4, 1.5, "中值滤波 3 点", "#ecfdf5", "#6ee7b7")
box(8.6, 5.6, 3.4, 1.5, "EWMA 平滑\n(λ=0.2)", "#fef2f2", "#fca5a5")
box(12.8, 5.6, 3.4, 1.5, "分级判定", "#eff6ff", "#93c5fd")
box(17.0, 5.6, 3.4, 1.5, "抑制去重 2 min", "#ecfdf5", "#6ee7b7")
box(17.0, 3.0, 3.4, 1.5, "告警 / 自动建单", "#faf5ff", "#d8b4fe")

arrow(3.6, 6.35, 4.4, 6.35)
arrow(7.8, 6.35, 8.6, 6.35)
arrow(12.0, 6.35, 12.8, 6.35)
arrow(16.2, 6.35, 17.0, 6.35)
arrow(18.7, 5.6, 18.7, 4.5)

# 分叉：从 EWMA 平滑引出两通道
arrow(10.3, 5.6, 8.0, 3.0)
arrow(10.3, 5.6, 12.6, 3.0)

box(6.2, 1.5, 3.4, 1.5, "阈值判定（三级）", "#eff6ff", "#93c5fd")
box(10.9, 1.5, 3.4, 1.5, "EWMA 趋势检测", "#fef2f2", "#fca5a5")
arrow(7.9, 1.5, 9.6, 0.55)
arrow(12.6, 1.5, 10.9, 0.55)
box(8.6, 0.05, 3.4, 1.0, "取较高等级", "#f9fafb", "#9ca3af", fs=10)

# 右侧说明
ax.text(15.2, 3.4,
        "阈值通道：EWMA 平滑值 ＋ 连续 2 点确认",
        fontsize=9.6, color="#1d4ed8")
ax.text(15.2, 2.7,
        "EWMA 通道：EWMA 平滑（λ=0.2）＋60 s 窗最小二乘斜率",
        fontsize=9.6, color="#b91c1c")
ax.text(15.2, 2.0,
        "控制限：r ≥ L·σr（理论计算，L≈3）",
        fontsize=9.6, color="#b91c1c")
ax.text(15.2, 1.3,
        "相对纯阈值判据：缓变检出提前 1 043 s",
        fontsize=9.6, color="#b91c1c")

# 底部注
ax.text(0.2, -0.55,
        "注：两通道共用同一 EWMA 滤波序列——阈值通道以 EWMA 平滑值判越限，变化率通道以 EWMA 序列斜率判趋势，故滤波不一致从根源消除；抑制去重窗口 2 min。",
        fontsize=9, color="#4b5563")

plt.tight_layout()
out = r"D:/驭弓大师/10_创新升级/fig3_ewma_v3.png"
plt.savefig(out, bbox_inches="tight", facecolor="white")
print("saved:", out)
