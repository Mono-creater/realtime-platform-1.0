# -*- coding: utf-8 -*-
"""重绘图2「双包上报协议时序与状态字位域」（高分辨率投稿版）

坐标体系：沿用原图 1265×788 像素坐标系（x 右、y 下），1:1 复刻版式。
版式：画布宽 9.6 in，论文中显示宽 14.60 cm（缩放 0.5988）；字号保证印刷 ≥ 6.9 pt。
配色取自原图采样：灰带 #eef0f3/#c5cad1，蓝带 #e4ecf5/#144572，
                 主包框 #40688c（异常红 #a42727），10 点均值框 #17696a，
                 子包框 #fdf0f0/#a42727。
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle
from matplotlib import font_manager

for f in ["Microsoft YaHei", "SimHei"]:
    try:
        font_manager.findfont(f, fallback_to_default=False)
        plt.rcParams["font.sans-serif"] = [f]
        break
    except Exception:
        continue
plt.rcParams["axes.unicode_minus"] = False

W_PX, H_PX = 1265, 788
FIG_W = 9.6
fig = plt.figure(figsize=(FIG_W, FIG_W * H_PX / W_PX), dpi=300)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, W_PX); ax.set_ylim(H_PX, 0)
ax.axis("off")

DARK, GRAY, LGRAY = "#2b2d30", "#4a4b4e", "#6a6f77"
GREY_E, GREY_F = "#c5cad1", "#eef0f3"
BLUE_E, BLUE_F = "#144572", "#e4ecf5"
PKG_E = "#40688c"
TEAL_E = "#17696a"
RED_E, RED_F = "#a42727", "#fdf0f0"

XB0, XB1 = 163, 1242          # 色带左右边
XLAB = 112                    # 侧标签中心
SLOT = (XB1 - XB0) / 6.0      # 180.0
CTR = [XB0 + SLOT * (i + 0.5) for i in range(6)]
BOUND = [XB0 + SLOT * i for i in range(7)]

def rbox(x0, y0, x1, y1, fc, ec, rs=6, lw=1.1, z=3):
    ax.add_patch(FancyBboxPatch((x0, y0), x1 - x0, y1 - y0,
                                boxstyle="round,pad=0,rounding_size=%g" % rs,
                                fc=fc, ec=ec, lw=lw, zorder=z))

def seq_text(x, y, pieces, size, va="center"):
    """把若干 (文本, 颜色, 字重) 依次水平排列，返回末段右边界"""
    cur = x
    for txt, col, wt in pieces:
        t = ax.text(cur, y, txt, ha="left", va=va, fontsize=size,
                    color=col, fontweight=wt, zorder=9)
        fig.canvas.draw()
        bb = t.get_window_extent(fig.canvas.get_renderer())
        (x0, _), (x1, _) = ax.transData.inverted().transform(
            [(bb.x0, bb.y0), (bb.x1, bb.y1)])
        cur = x1 + 0.3
    return cur

# ---------- 标题 ----------
def title(y, tag, head, bold, tail):
    seq_text(22, y, [(tag, GRAY, "normal"), (head, DARK, "normal"),
                     (bold, DARK, "bold"), (tail, DARK, "normal")], 12.5)

title(26, "（a）", "正常周期：仅读主包，", "31 B", " / 事务")
title(353, "（b）", "异常周期：追读异常子包，", "62 B", " / 事务")
title(680, "（c）", "状态字（寄存器 ", "2004", "）位域与异常位图映射")

# ---------- 面板绘制器 ----------
def panel(gy0, by0, pkg_bad, sub):
    """gy0 = PLC 灰带顶边；by0 = 平台蓝带顶边"""
    # PLC 侧
    ax.text(XLAB, gy0 + 34, "PLC 侧", ha="center", va="center",
            fontsize=12, color=DARK, zorder=6)
    rbox(XB0, gy0, XB1, gy0 + 67, GREY_F, GREY_E, rs=7, lw=1.0)
    for i, c in enumerate(CTR):
        if i % 2 == 0:                      # 采样时刻：竖线
            ax.plot([c, c], [gy0 + 18, gy0 + 49], color="#4a4b4e", lw=1.6, zorder=5,
                    solid_capstyle="butt")
        else:                               # 10 点均值
            rbox(c - 71, gy0 + 16, c + 71, gy0 + 51, "white", TEAL_E, rs=6, lw=1.2)
            ax.text(c, gy0 + 34, "10 点均值", ha="center", va="center",
                    fontsize=11.5, color="#14504f", zorder=6)
        ax.text(c, gy0 + 78, "100 ms", ha="center", va="center",
                fontsize=11, color=LGRAY, zorder=6)
    # 平台侧
    ax.text(XLAB, by0 + 34, "平台侧", ha="center", va="center",
            fontsize=12, color=DARK, zorder=6)
    rbox(XB0, by0, XB1, by0 + 67, BLUE_F, BLUE_E, rs=7, lw=1.3)
    for i, c in enumerate(CTR):
        bad = i + 1 in pkg_bad
        e = RED_E if bad else PKG_E
        rbox(c - 53, by0 + 15, c + 53, by0 + 52, "white", e, rs=6, lw=1.2)
        ax.text(c, by0 + 34, "主包", ha="center", va="center",
                fontsize=11.5, color=RED_E if bad else "#1b3d5c", zorder=6)
    # 子包行
    if sub:
        for i in (2, 3, 4):
            c = CTR[i]
            rbox(c - 52, by0 + 75, c + 52, by0 + 101, RED_F, RED_E, rs=6, lw=1.2)
            ax.text(c, by0 + 88, "子包", ha="center", va="center",
                    fontsize=11.5, color=RED_E, zorder=6)

panel(47, 163, set(), False)          # (a) 正常周期
panel(365, 482, {3, 4, 5}, True)      # (b) 异常周期

# ---------- 面板 (c)：状态字位域 ----------
BIT = [("bit7", "子包有效", RED_E, RED_F),
       ("bit6", "扩展协议", "#c0641a", "#fdf6ee"),
       ("bit5—3", "保留", "#cfd4d8", "#f6f7f8"),
       ("bit2", "湿度异常", "#1f4e79", "#eef4fa"),
       ("bit1", "压力异常", "#1f4e79", "#eef4fa"),
       ("bit0", "温度异常", "#1f4e79", "#eef4fa")]
CY0, CY1 = 690, 756
XS = [23, 225, 428, 633, 836, 1039, 1241]
for i, (bit, lab, ec, fc) in enumerate(BIT):
    x0, x1 = XS[i], XS[i + 1]
    ax.add_patch(Rectangle((x0, CY0), x1 - x0, CY1 - CY0, fc=fc, ec="none", zorder=3))
    for xx in (x0, x1):
        ax.plot([xx, xx], [CY0, CY1], color=ec, lw=1.6, zorder=5, solid_capstyle="butt")
    for yy in (CY0, CY1):
        ax.plot([x0, x1], [yy, yy], color=ec, lw=1.6, zorder=5, solid_capstyle="butt")
    dim = (i == 2)
    ax.text((x0 + x1) / 2, CY0 + 17, bit, ha="center", va="center",
            fontsize=11.5, color="#b9c0c6" if dim else ec,
            fontweight="normal" if dim else "bold", zorder=6)
    ax.text((x0 + x1) / 2, CY0 + 46, lab, ha="center", va="center",
            fontsize=11.5, color="#b9c0c6" if dim else DARK, zorder=6)

out = r"D:/驭弓大师/10_创新升级/fig2_proto_v2.png"
plt.savefig(out, facecolor="white")
plt.close(fig)
print("saved:", out)
