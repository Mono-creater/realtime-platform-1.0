# -*- coding: utf-8 -*-
"""重绘图4 / 图5（高分辨率投稿版）

数据来源与口径（与表6、表7、正文完全一致）：
  日流量(MB/d) = 86400 * (31 + 31λ) / P / 1048576      # 31 B/事务，异常周期追读子包再增 31 B
  压缩倍数     = 98.8755 / 日流量                        # 基线 3 通道 100 Hz × 32 bit = 98.9 MB/d
  图5(a)：表7 的 真实丢包率 / 估计均值 / 标准差（n = 200 次试验）
  图5(b)：正文 3.4 节的突发信道平均绝对误差 0.502 / 1.543 / 3.970 百分点

版式：画布宽 9.6 in，论文中显示宽 14.60 cm，缩放 0.5988；字号 ≥ 11.5 pt 保证印刷 ≥ 6.9 pt。
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
import numpy as np

for f in ["Microsoft YaHei", "SimHei"]:
    try:
        font_manager.findfont(f, fallback_to_default=False)
        plt.rcParams["font.sans-serif"] = [f]
        break
    except Exception:
        continue
plt.rcParams["axes.unicode_minus"] = False

MIB = 1048576.0
BASE = 3 * 100 * 4 * 86400 / MIB          # 98.8755 MB/d
P = [0.5, 1, 2, 5, 10]
LAM = [0.0, 0.05, 0.20, 1.0]
NAME = ["异常率 0%", "异常率 5%", "异常率 20%", "异常率 100%"]
COLOR = ["#1f4e79", "#a62639", "#2d6a4f", "#d97706"]
daily = {l: [86400 * (31 + 31 * l) / p / MIB for p in P] for l in LAM}
ratio = {l: [BASE / v for v in daily[l]] for l in LAM}

x = np.arange(len(P))

# ==================== 图4 ====================
fig, (a1, a2) = plt.subplots(1, 2, figsize=(9.6, 4.063), dpi=300)
fig.subplots_adjust(left=0.085, right=0.985, top=0.88, bottom=0.115, wspace=0.22)

w = 0.20
for i, l in enumerate(LAM):
    a1.bar(x + (i - 1.5) * w, daily[l], width=w, color=COLOR[i],
           edgecolor="#333333", linewidth=0.5, label=NAME[i], zorder=3)
a1.axhline(BASE, color="#a62639", ls="--", lw=1.3, zorder=4)
a1.text(0.985, BASE - 3.6, "原始波形基线 98.9 MB/d", color="#a62639",
        fontsize=11, ha="right", va="top", zorder=5,
        transform=a1.get_yaxis_transform())
a1.set_xticks(x); a1.set_xticklabels(["%g" % p for p in P], fontsize=13)
a1.set_ylim(0, 105); a1.set_yticks([0, 25, 50, 75, 100])
a1.tick_params(labelsize=13)
a1.set_ylabel("日流量 / (MB·d$^{-1}$)", fontsize=13.5)
a1.grid(axis="y", ls=":", lw=0.7, color="#bbbbbb", zorder=0)
a1.set_axisbelow(True)
a1.legend(ncol=2, fontsize=11.5, loc="upper left", bbox_to_anchor=(0.005, 0.815),
          framealpha=0.95, borderpad=0.45, labelspacing=0.4,
          columnspacing=0.9, handlelength=1.4)
a1.text(-0.085, 1.055, "(a)", transform=a1.transAxes, fontsize=14.5,
        fontweight="bold", va="bottom")

for i, l in enumerate(LAM):
    a2.plot(x, ratio[l], marker="s", ms=5.5, lw=1.7, color=COLOR[i],
            label=NAME[i], zorder=3)
a2.set_yscale("log")
a2.set_ylim(10, 1000)
a2.set_yticks([10, 20, 50, 100, 200, 500, 1000])
a2.set_yticklabels(["10", "20", "50", "100", "200", "500", "1000"], fontsize=13)
a2.set_xticks(x); a2.set_xticklabels(["%g" % p for p in P], fontsize=13)
a2.set_ylabel("相对原始波形的压缩倍数", fontsize=13.5)
a2.grid(axis="y", ls="-", lw=0.6, color="#dddddd", zorder=0)
a2.set_axisbelow(True)
a2.legend(fontsize=12, loc="upper left", framealpha=0.95,
          borderpad=0.5, labelspacing=0.45, handlelength=2.0)
a2.text(-0.085, 1.055, "(b)", transform=a2.transAxes, fontsize=14.5,
        fontweight="bold", va="bottom")

out4 = r"D:/驭弓大师/10_创新升级/fig4_flow_v2.png"
plt.savefig(out4, facecolor="white", bbox_inches="tight", pad_inches=0.03)
plt.close(fig)
print("saved:", out4)

# ==================== 图5 ====================
truth = np.array([1, 5, 10, 25, 50], dtype=float)
est = np.array([0.990, 5.010, 9.987, 24.959, 49.939])
sd = np.array([0.140, 0.303, 0.404, 0.581, 0.668])
burst = [0.502, 1.543, 3.970]

fig, (b1, b2) = plt.subplots(1, 2, figsize=(9.6, 3.84), dpi=300)
fig.subplots_adjust(left=0.095, right=0.985, top=0.875, bottom=0.16, wspace=0.24)

b1.plot([0, 56], [0, 56], ls="--", lw=1.1, color="#9a9a9a", zorder=2)
b1.errorbar(truth, est, yerr=sd, fmt="s", ms=5.5, color="#1f4e79",
            ecolor="#1f4e79", elinewidth=1.1, capsize=3.2, capthick=1.1, zorder=3)
b1.set_xlim(0, 56); b1.set_ylim(0, 56)
b1.set_xticks([0, 20, 40]); b1.set_yticks([0, 20, 40])
b1.tick_params(labelsize=13)
b1.set_xlabel("真实丢包率 / %", fontsize=13.5)
b1.set_ylabel("平台估计丢包率 / %", fontsize=13.5)
b1.grid(axis="x", ls=":", lw=0.7, color="#cccccc", zorder=0)
b1.set_axisbelow(True)
b1.text(31.5, 33.5, "y = x", fontsize=12.5, color="#8a8a8a", rotation=34,
        ha="left", va="bottom")
b1.text(0.04, 0.90, "误差棒为 200 次试验标准差", transform=b1.transAxes,
        fontsize=11.5, color="#555555", va="top")
b1.text(-0.105, 1.06, "(a)", transform=b1.transAxes, fontsize=14.5,
        fontweight="bold", va="bottom")

xb = np.arange(3)
b2.bar(xb, burst, width=0.52, color="#2d6a4f", edgecolor="#1f4d38", linewidth=0.6, zorder=3)
for i, v in enumerate(burst):
    b2.text(i, v + 0.09, "%.2f" % v, ha="center", fontsize=12.5, color="#14361f")
b2.set_xticks(xb)
b2.set_xticklabels(["轻度突发\n真值 1.0%", "中度突发\n真值 4.9%", "重度突发\n真值 17.3%"],
                   fontsize=12.5)
b2.set_ylim(0, 5); b2.set_yticks([0, 1, 2, 3, 4, 5])
b2.tick_params(labelsize=13)
b2.set_ylabel("丢包率估计绝对误差 / 百分点", fontsize=13.5)
b2.grid(axis="y", ls=":", lw=0.7, color="#bbbbbb", zorder=0)
b2.set_axisbelow(True)
b2.text(-0.095, 1.06, "(b)", transform=b2.transAxes, fontsize=14.5,
        fontweight="bold", va="bottom")

out5 = r"D:/驭弓大师/10_创新升级/fig5_loss_v2.png"
plt.savefig(out5, facecolor="white", bbox_inches="tight", pad_inches=0.03)
plt.close(fig)
print("saved:", out5)

print()
print("数据核对（与表6 对照）：")
for l in LAM:
    print('  λ=%-5s 日流量 %s' % (l, ' '.join('%.3f' % v for v in daily[l])))
print('  λ=0  压缩倍数 %s   （表6: 19.35 / 38.71 / 77.42 / 193.55 / 387.10）'
      % ' '.join('%.2f' % v for v in ratio[0.0]))
print('  λ=1  压缩倍数 %s   （表6: 9.68 / 19.35 / 38.71 / 96.77 / 193.55）'
      % ' '.join('%.2f' % v for v in ratio[1.0]))
print('  基线 %s vs %.2f MB/d' % (BASE, 98.9))
