# -*- coding: utf-8 -*-
"""重绘图7 v2：端到端告警时延与构成，与正文 #414 口径一致
(a) 边缘判阈路径 / 平台引擎路径时延 vs 轮询周期（含 p95）
(b) 2 s 轮询下平台引擎路径的时延构成分解（不含旧“持续性投票 90 s”）
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
import numpy as np

for f in ["Microsoft YaHei", "SimHei", "PingFang SC"]:
    try:
        font_manager.findfont(f, fallback_to_default=False)
        plt.rcParams["font.sans-serif"] = [f]
        break
    except Exception:
        continue
plt.rcParams["axes.unicode_minus"] = False

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 4.3), dpi=200,
                               gridspec_kw={"width_ratios": [1.35, 1.0]})

# ---------- (a) 时延 vs 轮询周期 ----------
P = [0.5, 1, 2, 5, 10]
edge = [1.25, 1.50, 2.00, 3.48, 6.00]
p95 = [1.47, 1.95, 2.90, 5.73, 10.55]
plat = [2.00, 3.00, 5.00, 11.00, 21.00]   # 边缘 + 1.5P

xi = np.arange(len(P))
ax1.bar(xi - 0.19, edge, width=0.38, color="#1f4e79", label="边缘判阈路径均值", zorder=2)
ax1.bar(xi + 0.19, plat, width=0.38, color="#d97706", label="平台引擎路径均值", zorder=2)
ax1.plot(xi, p95, "s--", color="#6b7280", ms=5, lw=1.4, label="p95 分位（边缘）", zorder=3)
for i, (e, p) in enumerate(zip(edge, plat)):
    ax1.text(i - 0.19, e - 0.75, "%.2f" % e, ha="center", fontsize=7.2, color="#1f4e79")
    ax1.text(i + 0.19, p + 0.30, "%.2f" % p, ha="center", fontsize=7.2, color="#b45309")
for i, v in enumerate(p95):
    ax1.text(i + 0.34, v, "%.2f" % v, ha="left", fontsize=7.0, color="#4b5563", va="center")
ax1.set_xticks(xi); ax1.set_xticklabels(["%g" % v for v in P])
ax1.set_xlabel("轮询周期 P / s", fontsize=10.5)
ax1.set_ylabel("端到端告警时延 / s", fontsize=10.5)
ax1.set_ylim(0, 32)
ax1.grid(axis="y", ls=":", lw=0.6, alpha=0.5, zorder=0)
ax1.legend(loc="upper left", fontsize=8.6, framealpha=0.9)
ax1.set_title("(a)", loc="left", fontsize=11, y=0.98)

# ---------- (b) 2 s 轮询下平台引擎路径时延构成 ----------
items = [
    ("10 点滑窗建立", 1.00, "#1f4e79"),
    ("轮询相位等待", 1.00, "#b91c1c"),
    ("中值滤波 + EWMA 预热", 1.00, "#7c3aed"),
    ("连续 2 点确认", 2.00, "#047857"),
]
ypos = np.arange(len(items))[::-1]
for y, (name, val, c) in zip(ypos, items):
    ax2.barh(y, val, height=0.52, color=c, zorder=2)
    ax2.text(val + 0.06, y, "%.2f s" % val, va="center", fontsize=8.6, color="#1f2937")
ax2.set_yticks(ypos)
ax2.set_yticklabels([i[0] for i in items], fontsize=9.2)
ax2.set_xlabel("时延 / s", fontsize=10.5)
ax2.set_xlim(0, 3.6)
ax2.grid(axis="x", ls=":", lw=0.6, alpha=0.5, zorder=0)
ax2.set_title("(b) 平台引擎路径构成（P = 2 s，合计 5.00 s）", loc="left", fontsize=10.5, y=0.98)

plt.tight_layout()
out = r"D:/驭弓大师/10_创新升级/fig7_latency_v2.png"
plt.savefig(out, bbox_inches="tight", facecolor="white")
print("saved:", out)
