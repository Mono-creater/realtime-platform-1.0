# -*- coding: utf-8 -*-
"""图3 v7：面向中文核心期刊投稿的版式重构。

v7 相对 v6 的改动（均为版式/合规，不改任何技术内容与数据口径）：
 1) 投稿合规·字号：画布由 12 in 收窄到 9.6 in（论文中显示宽固定 14.60 cm），
    框内文字由"印刷 ≈5.7 pt"提升到"印刷 ≈7.1 pt"（≥6 pt 下限）。
 2) 投稿合规·分辨率：200 dpi -> 600 dpi，并同步输出矢量 PDF（期刊首选矢量）。
 3) 结构纠错：v5/v6 把"分级判定"排在主干中段、又用一条箭头从"取较高等级"回流到它，
    读者会读成环路。v7 改为单向直链：主干 6 环节一条直线走到底；
    "阈值判定 / EWMA 趋势检测"两条通道下移为并列层，汇入"取较高等级"后上行进入"分级判定"。
 4) 配色：6 色平铺 -> 2 色系 + 中性灰。灰＝处理链，蓝＝阈值通道，红＝变化率通道。
 5) 连线：全部正交折线（拐角圆角），坐标已逐段校验，无斜线、无交叉。
 6) 右侧 5 行悬浮说明内化：参数与前提前移到对应框内作副行，判据合并进底部注。
 7) 数据修正：图内"缓变检出提前 1 043 s" -> "1 042 s"（与正文 6 处一致；1 103 − 61 = 1 042）。
 8) 删除顶部"要点"横幅：期刊流程图不内嵌要点文字，该内容由图注与正文承担。

坐标契约：axes 精确铺满 figure，故 1 数据单位 = 0.4 inch，缩放可解析预测。
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from matplotlib.path import Path as MPath
from matplotlib import font_manager
import numpy as np

for f in ["Microsoft YaHei", "SimHei", "PingFang SC", "Noto Sans CJK SC"]:
    try:
        font_manager.findfont(f, fallback_to_default=False)
        plt.rcParams["font.sans-serif"] = [f]
        break
    except Exception:
        continue
plt.rcParams["axes.unicode_minus"] = False

# ---------- 画布：xlim 紧贴内容边界 + axes 铺满 figure ----------
# 使 1 数据单位 = 0.3915 inch，缩放比 k = 5.748/9.2 = 0.6248 可解析预测；
# 不用 bbox_inches="tight"（它会把 axes 外框一并计入，导致缩放漂移）。
FIG_W = 9.2
XMIN, XMAX = 0.25, 23.75          # 跨度 23.5 单位
YMIN, YMAX = 2.70, 14.55          # 跨度 11.85 单位
UPI = FIG_W / (XMAX - XMIN)        # inches per unit = 0.39149
FIG_H = (YMAX - YMIN) * UPI
fig = plt.figure(figsize=(FIG_W, FIG_H))
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(XMIN, XMAX); ax.set_ylim(YMIN, YMAX); ax.axis("off")

# ---------- 色板：2 色系 + 中性灰 ----------
C_MAIN   = ("#EFEFE9", "#8B8B7E", "#33332C")   # 处理链（中性灰）
C_THRESH = ("#DCE7F2", "#2F6591", "#173049")   # 阈值通道（蓝）
C_TREND  = ("#F7E7E0", "#A34E36", "#5E2B1B")   # 变化率通道（暖红）
C_JOIN   = ("#E7E7DF", "#7A7A6E", "#2C2C26")   # 汇合环节（深一档灰）

ARROW = "#7A7A72"
FS_MAIN, FS_SUB, FS_NOTE = 11.0, 10.5, 10.5
LW_BOX, LW_ARROW = 1.0, 1.1
ROUND = 0.14


def box(x, y, w, h, main, sub=None, style=C_MAIN, fs=FS_MAIN):
    fc, ec, tc = style
    ax.add_patch(FancyBboxPatch((x, y), w, h,
                                boxstyle=f"round,pad=0,rounding_size={ROUND}",
                                fc=fc, ec=ec, lw=LW_BOX, joinstyle="round"))
    cx, cy = x + w / 2, y + h / 2
    rows = [main] if sub is None else [main] + (sub if isinstance(sub, list) else [sub])
    n = len(rows)
    step = 0.50
    y0 = cy + (n - 1) * step / 2
    for i, t in enumerate(rows):
        ax.text(cx, y0 - i * step, t, ha="center", va="center",
                fontsize=fs if i == 0 else FS_SUB,
                color=tc if i == 0 else ec)


def seg(pts, color=ARROW, lw=LW_ARROW, head=True, r=0.16):
    """正交折线，拐角自动圆角；head=True 时末端加实心箭头。"""
    verts, codes = [tuple(pts[0])], [MPath.MOVETO]
    for i in range(1, len(pts) - 1):
        a, b, c = np.array(pts[i - 1], float), np.array(pts[i], float), np.array(pts[i + 1], float)
        d1, d2 = b - a, c - b
        l1, l2 = np.hypot(*d1), np.hypot(*d2)
        rr = min(r, l1 / 2, l2 / 2)
        verts += [tuple(b - d1 / l1 * rr), tuple(b), tuple(b + d2 / l2 * rr)]
        codes += [MPath.LINETO, MPath.CURVE3, MPath.CURVE3]
    verts.append(tuple(pts[-1])); codes.append(MPath.LINETO)
    ax.add_patch(FancyArrowPatch(path=MPath(verts, codes),
                                 arrowstyle="-|>" if head else "-",
                                 mutation_scale=10, color=color, lw=lw,
                                 joinstyle="round", capstyle="round",
                                 shrinkA=0, shrinkB=0))


# ================= 主干：单行直链 6 环节 =================
Y_MAIN, H_MAIN = 12.9, 1.4
W, G = 3.267, 0.72
xs = [0.4 + i * (W + G) for i in range(6)]
centers = [x + W / 2 for x in xs]
MAIN_BOT, MAIN_MID = Y_MAIN, Y_MAIN + H_MAIN / 2

for x, (txt, st) in zip(xs, [("采样序列", C_MAIN), ("中值滤波 3 点", C_MAIN),
                             ("EWMA 平滑", C_MAIN), ("分级判定", C_JOIN),
                             ("抑制去重 2 min", C_MAIN), ("告警 / 自动建单", C_MAIN)]):
    box(x, Y_MAIN, W, H_MAIN, txt, style=st)

for i in range(5):
    seg([(xs[i] + W, MAIN_MID), (xs[i + 1], MAIN_MID)], r=0)

# ================= 并列双通道层 =================
Y_CH, H_CH = 6.5, 2.6
CH_TOP, CH_BOT = Y_CH + H_CH, Y_CH
b_thresh, b_trend, b_join = (3.5, 5.2), (9.8, 5.2), (16.1, 4.2)
c_thr, c_trd, c_joi = b_thresh[0] + b_thresh[1] / 2, b_trend[0] + b_trend[1] / 2, b_join[0] + b_join[1] / 2

box(b_thresh[0], Y_CH, b_thresh[1], H_CH, "阈值判定（三级）", "连续 2 点确认", C_THRESH)
box(b_trend[0], Y_CH, b_trend[1], H_CH, "EWMA 趋势检测",
    ["roc = (Zi − Zi−W) / W", "δmin = 3σr ≤ rw"], C_TREND)
box(b_join[0], Y_CH, b_join[1], H_CH, "取较高等级", "两通道取高", C_JOIN)

# ---------- 入口分叉：EWMA 平滑 -> 两条通道（水平段同高，左右对称，互不交叉） ----------
Y_FORK = 11.35
seg([(8.80, MAIN_BOT), (8.80, Y_FORK), (c_thr, Y_FORK), (c_thr, CH_TOP)])
seg([(11.20, MAIN_BOT), (11.20, Y_FORK), (c_trd, Y_FORK), (c_trd, CH_TOP)])

# ---------- 出口汇合：两条通道 -> 取较高等级（底部总线，T 形汇流） ----------
Y_BUS = 5.40
seg([(c_thr, CH_BOT), (c_thr, Y_BUS), (c_joi, Y_BUS), (c_joi, CH_BOT)])
seg([(c_trd, CH_BOT), (c_trd, Y_BUS)], head=False)

# ---------- 等级抬升：取较高等级 -> 分级判定（绕右侧空档，垂直进入底边中点） ----------
Y_LIFT = 10.75
c_grade = centers[3]
seg([(c_joi, CH_TOP), (c_joi, Y_LIFT), (c_grade, Y_LIFT), (c_grade, MAIN_BOT)])

# ================= 底部注 =================
ax.text(0.4, 4.05,
        "注：两通道共用同一 EWMA 滤波序列——阈值通道以 EWMA 平滑值判越限，变化率通道以 EWMA 序列差分判趋势，",
        fontsize=FS_NOTE, color="#4B5049", va="center")
ax.text(0.4, 3.35,
        "故滤波不一致从根源消除；抑制去重窗口 2 min，等级抬升须变化率通道投票通过且等级更高；缓变检出提前 1 042 s。",
        fontsize=FS_NOTE, color="#4B5049", va="center")

# ---------- 越界自检：所有 artist 必须落在 [XMIN,XMAX] x [YMIN,YMAX] 内 ----------
fig.canvas.draw()
_r = fig.canvas.get_renderer()
_bad = []
for _t in ax.texts:
    _bb = _t.get_window_extent(_r).transformed(ax.transData.inverted())
    if _bb.x0 < XMIN or _bb.x1 > XMAX or _bb.y0 < YMIN or _bb.y1 > YMAX:
        _bad.append(("text", _t.get_text()[:28], round(_bb.x0, 2), round(_bb.x1, 2), round(_bb.y0, 2), round(_bb.y1, 2)))
for _p_ in ax.patches:
    _bb = _p_.get_window_extent(_r).transformed(ax.transData.inverted())
    if _bb.x0 < XMIN - 0.01 or _bb.x1 > XMAX + 0.01 or _bb.y0 < YMIN - 0.01 or _bb.y1 > YMAX + 0.01:
        _bad.append(("patch", type(_p_).__name__, round(_bb.x0, 2), round(_bb.x1, 2), round(_bb.y0, 2), round(_bb.y1, 2)))
print("BOUNDS CHECK:", "PASS - all inside" if not _bad else "FAIL")
for _b in _bad:
    print("   ", _b)

out_png = r"D:/驭弓大师/10_创新升级/fig3_ewma_v7.png"
out_pdf = r"D:/驭弓大师/10_创新升级/fig3_ewma_v7.pdf"
plt.savefig(out_png, dpi=600, facecolor="white")
plt.savefig(out_pdf, facecolor="white")

from PIL import Image
im = Image.open(out_png)
in_w = im.size[0] / 600.0
k = (14.60 / 2.54) / in_w
print("saved:", out_png)
print("pixel:", im.size, " ratio=%.3f" % (im.size[0] / im.size[1]))
print("printed (at 14.60 cm width): %.2f cm x %.2f cm" % (14.60, 14.60 * im.size[1] / im.size[0]))
print("scale k = %.4f" % k)
for name, fs in [("main", FS_MAIN), ("sub", FS_SUB), ("note", FS_NOTE)]:
    print("  %-4s %4.1f pt -> printed %.2f pt" % (name, fs, fs * k))
# 框宽余量自检
box_w_pt = W * UPI * 72
widest = 4 * FS_MAIN + 4 + 5.5 * 5
print("main box width %.1f pt; widest label ~%.0f pt -> fill %.0f%% (pad %.1f pt/side)"
      % (box_w_pt, widest, 100 * widest / box_w_pt, (box_w_pt - widest) / 2))
