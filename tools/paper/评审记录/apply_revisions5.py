# -*- coding: utf-8 -*-
"""第五批修改：修复P63语义重复 + 同步P52图3描述"""
import os, zipfile
from lxml import etree

SRC = r"D:/驭弓大师/03_论文打磨版_驭弓大师.docx"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
def qn(t): return W + t
def read_parts(path):
    z = zipfile.ZipFile(path); d = {n: z.read(n) for n in z.namelist()}; z.close(); return d
def write_parts(parts, dst):
    tmp = dst + ".tmp"
    z = zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED)
    for n, data in parts.items(): z.writestr(n, data)
    z.close()
    if os.path.exists(dst): os.remove(dst)
    os.replace(tmp, dst)
def set_text_keep_style(p, new_text):
    runs = p.findall(qn("r"))
    if not runs: return False
    first = runs[0]
    for r in runs[1:]: p.remove(r)
    for child in list(first):
        if child.tag in (qn("t"), qn("br"), qn("tab")): first.remove(child)
    t = etree.SubElement(first, qn("t")); t.text = new_text
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return True
def ptext(p): return "".join(t.text or "" for t in p.iter(qn("t")))

parts = read_parts(SRC)
root = etree.fromstring(parts["word/document.xml"])
paras = root.findall(".//" + qn("body") + "/" + qn("p"))
log = []

# ---- 修复 P63：去掉开头重复句，让"窗口解耦"先行，再引入EWMA ----
for p in paras:
    pt = ptext(p)
    if pt.startswith("为从根源上消除上述不一致并给出可解析的误报控制，本文进一步将变化率统计量统一到 EWMA 序列上。在此之前，变化率窗口须先与轮询周期解耦："):
        # 删掉开头那句，直接从"变化率窗口须与轮询周期解耦"开始
        new = pt.replace(
            "为从根源上消除上述不一致并给出可解析的误报控制，本文进一步将变化率统计量统一到 EWMA 序列上。在此之前，变化率窗口须先与轮询周期解耦：",
            "为从根源上消除上述不一致，本文进一步将变化率统计量统一到 EWMA 序列上。作为前提，变化率窗口须先与轮询周期解耦：")
        # 再把中段"在此基础上，为进一步消除阈值通道与变化率通道的滤波不一致并给出可解析的误报控制，本文以 EWMA 序列的斜率作为变化率统计量"
        new = new.replace(
            "在此基础上，为进一步消除阈值通道与变化率通道的滤波不一致并给出可解析的误报控制，本文以 EWMA 序列的斜率作为变化率统计量：",
            "在窗口与周期解耦的基础上，本文以 EWMA 序列的斜率作为变化率统计量：")
        set_text_keep_style(p, new)
        log.append("P63 已修复语义重复")
        break

# ---- 同步 P52 图3 描述（体现 EWMA 平滑为共用滤波级）----
for p in paras:
    pt = ptext(p)
    if pt.startswith("告警引擎处理链如图 3 所示："):
        new = ("告警引擎处理链如图 3 所示：3 点中值滤波 → EWMA 平滑 → 分级判定"
               "（阈值分级与 EWMA 趋势检测并行判定）→ 取较高等级 → 抑制去重 → 确认与解除留痕。"
               "其中阈值通道以 EWMA 平滑值判越限，变化率通道以 EWMA 序列斜率判趋势，"
               "两者共用同一滤波序列。")
        set_text_keep_style(p, new)
        log.append("P52 已同步图3描述")
        break

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join(log) if log else "无修改")
