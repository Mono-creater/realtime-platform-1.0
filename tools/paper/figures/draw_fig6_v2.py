# -*- coding: utf-8 -*-
"""重绘图6 v2：按真实复算数据（600 次试验）绘制 λ 敏感性
- 柱：纯噪声误报率（λ=0.1~0.4 为 0，λ=0.5 为 0.50%）
- 线：3 ℃/min 缓变检出时延（λ=0.1~0.5 恒为 61 s）
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

for f in ["Microsoft YaHei", "SimHei", "PingFang SC"]:
    try:
        font_manager.findfont(f, fallback_to_default=False)
        plt.rcParams["font.sans-serif"] = [f]
        break
    except Exception:
        continue
plt.rcParams["axes.unicode_minus"] = False

lam = [0.1, 0.2, 0.3, 0.4, 0.5]
fa  = [0.00, 0.00, 0.00, 0.00, 0.50]      # 误报率 %
lat = [61, 61, 61, 61, 61]                # 3 ℃/min 中位时延 s

fig, ax1 = plt.subplots(figsize=(9, 4.2), dpi=200)
x = range(len(lam))

b = ax1.bar([i - 0.18 for i in x], fa, width=0.36, color="#8ab4d8", edgecolor="#5b8db8",
            label="纯噪声误报率（左轴）", zorder=2)
for i, v in enumerate(fa):
    if v > 0:
        ax1.text(i - 0.18, v + 0.012, "%.2f%%" % v, ha="center", fontsize=8.5, color="#1f4e79")
ax1.set_ylabel("纯噪声误报率 / %", fontsize=10.5)
ax1.set_ylim(0, 1.0)
ax1.set_xticks(list(x)); ax1.set_xticklabels(["%.1f" % v for v in lam])
ax1.set_xlabel("EWMA 平滑系数 λ", fontsize=10.5)
ax1.grid(axis="y", ls=":", lw=0.6, alpha=0.5, zorder=0)

ax2 = ax1.twinx()
ax2.plot(list(x), lat, "o-", color="#c0392b", lw=2, ms=6, label="3 ℃/min 检出时延（右轴）", zorder=3)
ax2.set_ylabel("3 ℃/min 缓变检出时延 / s", fontsize=10.5, color="#c0392b")
ax2.set_ylim(40, 100)
ax2.tick_params(axis="y", labelcolor="#c0392b")
for i, v in enumerate(lat):
    ax2.annotate("%d s" % v, (i, v), textcoords="offset points", xytext=(0, 9),
                 ha="center", fontsize=8.5, color="#c0392b")

ax1.text(0.02, 0.88, "λ ≥ 0.2：误报率 0、检出时延恒定 61 s；λ = 0.5 起误报率略升（0.50%），故取 λ = 0.2",
         transform=ax1.transAxes, fontsize=9.2, color="#1f4e79", va="top")

h1, l1 = ax1.get_legend_handles_labels()
h2, l2 = ax2.get_legend_handles_labels()
ax1.legend(h1 + h2, l1 + l2, loc="upper right", fontsize=9, framealpha=0.9)

plt.tight_layout()
out = r"D:/驭弓大师/10_创新升级/fig6_lambda_v2.png"
plt.savefig(out, bbox_inches="tight", facecolor="white")
print("saved:", out)
