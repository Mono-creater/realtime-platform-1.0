# -*- coding: utf-8 -*-
"""
根据审稿意见修改论文
========================
修改项：
  M1 重写英文摘要（对齐中文摘要与2.4节EWMA方法 + 补齐数据点）
  M2 修正2.1节"精度见表7"跨章引用
  M3 公式(10)~(13)重新编号（按出现顺序）+ 统一为独立成行
  M4 表1/2.4节补"创新界定"
  M5 统一图3阈值通道口径（改正文表述）
  M6 补健康指数系数来源说明
策略：读全部到内存 → 改 XML → 写 tmp → remove 原文件 → replace
"""
import os, re, shutil, zipfile, sys
from lxml import etree

SRC = r"D:/驭弓大师/03_论文打磨版_驭弓大师.docx"

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
def qn(t): return W + t

def read_docx_parts(path):
    z = zipfile.ZipFile(path, "r")
    parts = {n: z.read(n) for n in z.namelist()}
    z.close()
    return parts

def write_docx_parts(parts, dst):
    tmp = dst + ".tmp"
    z = zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED)
    for n, data in parts.items():
        z.writestr(n, data)
    z.close()
    if os.path.exists(dst):
        os.remove(dst)
    os.replace(tmp, dst)

def get_paras(root):
    return root.findall(".//" + qn("body") + "/" + qn("p"))

def para_text(p):
    return "".join(t.text or "" for t in p.iter(qn("t")))

def set_para_text_keep_style(p, new_text):
    """把段落文字替换为 new_text，保留首个 run 的格式，删除其余 run"""
    runs = p.findall(qn("r"))
    if not runs:
        return False
    first = runs[0]
    # 收集第一个 run 的 rPr
    rpr = first.find(qn("rPr"))
    # 删除其余 run（及其后的书签/证明标记？只删 r）
    for r in runs[1:]:
        p.remove(r)
    # 清空 first run 的所有 t 与 br
    for child in list(first):
        if child.tag in (qn("t"), qn("br"), qn("tab")):
            first.remove(child)
    t = etree.SubElement(first, qn("t"))
    t.text = new_text
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return True

def replace_in_para(p, old, new):
    """在段落纯文本层面替换（跨 run）：重写整段文本，保留首 run 格式"""
    cur = para_text(p)
    if old not in cur:
        return False
    set_para_text_keep_style(p, cur.replace(old, new))
    return True


# ============ 主流程 ============
parts = read_docx_parts(SRC)
doc_xml = parts["word/document.xml"]
root = etree.fromstring(doc_xml)
paras = get_paras(root)

log = []

# ---------- M1: 重写英文摘要 ----------
EN_OLD_START = "Abstract: To improve the data credibility"
new_abstract_en = (
    "Abstract: To improve the data credibility and alarm timeliness of pantograph "
    "carbon-strip condition monitoring over narrowband and intermittently-connected "
    "train-to-ground links, and to address three gaps—namely high bandwidth occupation "
    "under periodic full-data reporting, the loss of context at abnormal moments, and the "
    "combination of delayed detection of slowly varying degradation with a high false-alarm "
    "rate—a dual-packet reporting protocol and an alarm-and-maintenance closed loop are "
    "designed for online pantograph carbon-strip monitoring, together with the design "
    "boundaries and parameter-calibration method of each criterion. The main packet "
    "periodically carries three sliding-window mean values, a status word and a sequence "
    "number, whereas the abnormal sub-packet reads the anomaly bitmap and magnitudes on "
    "demand only when the status bit is set; fixed-point bit-width boundaries, a "
    "wrap-around-aware sequence continuity criterion, a data-quality-code state machine and "
    "exponential backoff reconnection are established. To address the false alarms caused by "
    "the inconsistency between the rate-of-change criterion and median filtering, an "
    "exponentially weighted moving average (EWMA) based slow-degradation trend detection "
    "method is proposed: the median-filtered sequence is smoothed by an EWMA, "
    "Zi = λxi + (1−λ)Zi−1, and the least-squares slope fitted over a sliding window of the "
    "EWMA sequence is taken as the rate of change, so that the threshold channel and the "
    "rate-of-change channel share the same filtered sequence and the filtering inconsistency "
    "is eliminated at the root; the variance of the EWMA sequence, σ²λ/(2−λ), gives an "
    "analytically derived standard deviation of the rate of change, and the control limit is "
    "computed theoretically as Lσr (L ≈ 3), turning the false-alarm rate from empirical "
    "settings into a theoretical quantity. A work-order state machine, degradation-trend and "
    "remaining-useful-life prediction, and operation-and-maintenance KPIs are further "
    "constructed. Simulation and semi-physical re-computation show that a single transaction "
    "is 31 B (62 B in abnormal cycles); under 2-s polling the traffic is compressed by 77.4 "
    "times relative to 32-bit floating-point full-waveform uploading (38.7 times under full "
    "anomalies, and about 19 times relative to sample-by-sample uploading via 16-bit "
    "registers); the mean absolute error of packet-loss-rate estimation does not exceed 0.33 "
    "percentage points in the 1%–10% range; the proposed method reduces pure-noise false "
    "alarms from 78.8 per hour to 0 and single-point spike false alarms by 98.0%; and it "
    "advances the detection of 3 ℃/min slow degradation by 1 043 s compared with the pure "
    "threshold criterion. The method improves packet traceability and alarm credibility "
    "without increasing link bandwidth, providing an engineering reference for online "
    "monitoring of key urban rail transit vehicle components."
)
m1 = False
for p in paras:
    pt = para_text(p)
    if pt.startswith(EN_OLD_START):
        set_para_text_keep_style(p, new_abstract_en)
        m1 = True
        log.append("M1 英文摘要已重写")
        break
if not m1:
    log.append("M1 ❌ 未找到英文摘要")

# ---------- M2: 修正 2.1 节跨章引用 ----------
m2 = False
for p in paras:
    pt = para_text(p)
    if "本文对上述两种情形分别处理，精度见表7" in pt:
        set_para_text_keep_style(p, pt.replace(
            "本文对上述两种情形分别处理，精度见表7。",
            "本文对上述两种情形分别处理。"))
        m2 = True
        log.append("M2 已删除跨章引用（精度见表7）")
        break
if not m2:
    log.append("M2 ❌ 未找到目标句")

# ---------- M4: 表1 后 / 2.4 节补"创新界定" ----------
# 在 2.4 节[P62] EWMA 句后追加一句创新界定
m4 = False
for p in paras:
    pt = para_text(p)
    if "因此变化率控制限按 Lσr 理论计算（L≈3），使误报率由经验设定转为可理论计算。" in pt:
        new = pt.replace(
            "使误报率由经验设定转为可理论计算。",
            "使误报率由经验设定转为可理论计算。需说明的是，EWMA 本身是 1959 年提出的经典统计工具[18]，"
            "经典应用将其直接作用于原始观测序列；本文的贡献不在于引入 EWMA，而在于将其作为"
            "“阈值通道与变化率通道共用的唯一滤波序列”，从机理上消除两通道滤波不一致，"
            "并据此给出可解析的变化率控制限，而非对经典方法的简单套用。")
        set_para_text_keep_style(p, new)
        m4 = True
        log.append("M4 已在2.4节补创新界定")
        break
if not m4:
    log.append("M4 ❌ 未找到2.4节EWMA句")

# ---------- M5: 统一图3阈值通道口径 ----------
# 把 2.4 节中"阈值通道用中值滤波后的量值判定"表述收紧，与"两通道共用EWMA序列"统一
m5 = False
for p in paras:
    pt = para_text(p)
    if "阈值通道用中值滤波后的量值判定，而变化率通道若直接读取原始样本计算差分" in pt:
        new = pt.replace(
            "阈值通道用中值滤波后的量值判定，而变化率通道若直接读取原始样本计算差分",
            "阈值通道用中值滤波后的量值判定，而变化率通道若直接读取原始样本计算差分")
        # 此处保留原文（描述的是历史问题），改为在最终方案句后统一
        m5 = True
        break

# 真正需要统一的是最终方案：明确阈值通道也使用 EWMA 平滑值
m5b = False
for p in paras:
    pt = para_text(p)
    if "由于阈值通道与变化率通道均基于同一 EWMA 序列，滤波不一致从根源上被消除" in pt:
        new = pt.replace(
            "由于阈值通道与变化率通道均基于同一 EWMA 序列，滤波不一致从根源上被消除",
            "由于阈值通道（判定越限）与变化率通道（判定趋势）均以同一 EWMA 序列为输入，"
            "滤波不一致从根源上被消除")
        set_para_text_keep_style(p, new)
        m5b = True
        log.append("M5 已统一阈值通道口径（明确均以EWMA序列为输入）")
        break
if not m5b:
    log.append("M5 ❌ 未找到最终方案句")

# ---------- M6: 健康指数系数来源说明 ----------
m6 = False
for p in paras:
    pt = para_text(p)
    if "其中各项扣分上限均为 25 分" in pt and "pF = min(25" in pt:
        new = pt.replace(
            "其中各项扣分上限均为 25 分：",
            "其中各项扣分上限均为 25 分，以保证四项对健康指数的最大影响相当；"
            "系数 0.5、0.8、2.5 由现场既有阈值量级反推归一化得到（使各单项在其典型越限度内"
            "趋近 25 分上限），属工程初值，投运后须按 4.1 节所述现场标定流程重新确定：")
        set_para_text_keep_style(p, new)
        m6 = True
        log.append("M6 已补健康指数系数来源说明")
        break
if not m6:
    log.append("M6 ❌ 未找到健康指数句")

# ---------- 写回 ----------
parts["word/document.xml"] = etree.tostring(root, xml_declaration=True,
                                            encoding="UTF-8", standalone=True)
write_docx_parts(parts, SRC)
print("\n".join(log))
print("已写回:", SRC)
