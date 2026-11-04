# -*- coding: utf-8 -*-
"""重绘图3 v6：仅修复"等级抬升"箭头——不再穿过 EWMA 趋势检测框、不与汇合箭头交叉。
v6 相对 v5 的唯一改动：
  - "取较高等级"→"分级判定" 的灰色反馈箭头，由直线斜穿改为右侧直角绕行：
    右缘引出 → 水平向右 → 框右侧空档垂直上行 → 分级判定底边正中垂直进入（带圆角）。
  - 其余版式、文字、配色与 v5 完全一致。
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from matplotlib.path import Path as MPath
from matplotlib import font_manager

for f in ["Microsoft YaHei", "SimHei", "PingFang SC", "Noto Sans CJK SC"]:
    try:
        font_manager.findfont(f, fallback_to_default=False)
        plt.rcParams["font.sans-serif"] = [f]
        break
    except Exception:
        continue
plt.rcParams["axes.unicode_minus"] = False

fig, ax = plt.subplots(figsize=(12, 5.0), dpi=200)
ax.set_xlim(0, 24); ax.set_ylim(-0.5, 10); ax.axis("off")

def box(x, y, w, h, text, fc, ec, fs=11, bold=False):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.12,rounding_size=0.18",
                                fc=fc, ec=ec, lw=1.6))
    ax.text(x + w/2, y + h/2, text, ha="center", va="center", fontsize=fs,
            fontweight="bold" if bold else "normal", color="#1f2937", linespacing=1.4)

def arrow(x1, y1, x2, y2, color="#6b7280", lw=1.6, style="-|>"):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle=style,
                                 mutation_scale=13, color=color, lw=lw,
                                 shrinkA=1, shrinkB=1))

# 顶部要点（口径改为 EWMA 滑窗差分）
ax.text(0.2, 9.4, "要点：变化率通道须与阈值通道共用同一滤波序列，否则中值滤波对缓变判据失效；",
        fontsize=10.5, color="#111827")
ax.text(0.2, 8.9, "本文改用 EWMA 平滑＋滑窗差分统一滤波，从根源消除不一致并给出可解析的判据边界。",
        fontsize=10.5, color="#111827")

# 主干链（横向）
box(0.2, 6.4, 3.2, 1.5, "采样序列", "#eef2ff", "#818cf8")
box(4.0, 6.4, 3.2, 1.5, "中值滤波 3 点", "#ecfdf5", "#6ee7b7")
box(7.8, 6.4, 3.2, 1.5, "EWMA 平滑\n(λ=0.2)", "#fef2f2", "#fca5a5")
box(11.6, 6.4, 3.2, 1.5, "分级判定", "#eff6ff", "#93c5fd")
box(15.4, 6.4, 3.2, 1.5, "抑制去重 2 min", "#ecfdf5", "#6ee7b7")
box(19.2, 6.4, 3.6, 1.5, "告警 / 自动建单", "#faf5ff", "#d8b4fe")

arrow(3.4, 7.15, 4.0, 7.15)
arrow(7.2, 7.15, 7.8, 7.15)
arrow(11.0, 7.15, 11.6, 7.15)
arrow(14.8, 7.15, 15.4, 7.15)
arrow(18.6, 7.15, 19.2, 7.15)

# 分叉两通道（从 EWMA 平滑下方引出）
arrow(9.4, 6.4, 6.2, 4.2)    # -> 阈值判定
arrow(9.4, 6.4, 10.4, 4.2)   # -> EWMA 趋势检测

box(4.2, 2.7, 3.4, 1.5, "阈值判定（三级）", "#eff6ff", "#93c5fd")
box(9.2, 2.7, 3.4, 1.5, "EWMA 趋势检测", "#fef2f2", "#fca5a5")

# 两通道汇合到"取较高等级"
arrow(5.9, 2.7, 7.9, 1.55)
arrow(10.9, 2.7, 8.9, 1.55)
box(6.7, 0.5, 3.4, 1.05, "取较高等级", "#f9fafb", "#9ca3af", fs=10)

# 等级抬升：绕行 EWMA 趋势检测框右侧，垂直进入"分级判定"底边正中
# （不穿过任何流程框，不与其它箭头交叉）
r = 0.35                                   # 圆角半径
verts = [(10.1, 0.9),                      # 从"取较高等级"右缘引出
         (13.2 - r, 0.9),                  # 水平向右
         (13.2, 0.9), (13.2, 0.9 + r),     # 圆角
         (13.2, 6.40)]                     # 垂直上行，进入"分级判定"底边（箭头）
codes = [MPath.MOVETO, MPath.LINETO, MPath.CURVE3, MPath.CURVE3, MPath.LINETO]
ax.add_patch(FancyArrowPatch(path=MPath(verts, codes), arrowstyle="-|>",
                             mutation_scale=13, color="#9ca3af", lw=1.3,
                             joinstyle="round", capstyle="round"))

# 右侧说明
ax.text(14.4, 3.9, "阈值通道：EWMA 平滑值 ＋ 连续 2 点确认",
        fontsize=9.8, color="#1d4ed8")
ax.text(14.4, 3.2, "EWMA 通道：EWMA 平滑（λ=0.2）＋60 s 窗差分 roc=(Zi−Zi−W)/W",
        fontsize=9.8, color="#b91c1c")
ax.text(14.4, 2.5, "判据：δmin = 3σr ≤ rw（σr≈0.316 ℃/min，rw=2 ℃/min）",
        fontsize=9.8, color="#b91c1c")
ax.text(14.4, 1.8, "相对纯阈值判据：缓变检出提前 1 043 s",
        fontsize=9.8, color="#b91c1c")
ax.text(14.4, 1.1, "等级抬升：变化率仅在投票通过且等级更高时抬升",
        fontsize=9.8, color="#6b7280")

# 底部注
ax.text(0.2, -0.4,
        "注：两通道共用同一 EWMA 滤波序列——阈值通道以 EWMA 平滑值判越限、变化率通道以 EWMA 序列差分 roc=(Zi−Zi−W)/W 判趋势，故滤波不一致从根源消除；抑制去重窗口 2 min。",
        fontsize=8.6, color="#4b5563")

plt.tight_layout()
out = r"D:/驭弓大师/10_创新升级/fig3_ewma_v6.png"
plt.savefig(out, bbox_inches="tight", facecolor="white")
print("saved:", out)
