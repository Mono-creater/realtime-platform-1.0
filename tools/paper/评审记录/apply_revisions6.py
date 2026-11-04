# -*- coding: utf-8 -*-
"""第六批修改：消除口语化措辞"""
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

# 修正定量对照段的口语化措辞
for p in paras:
    pt = ptext(p)
    if "两者在监测对象、数据量与评价指标上互补" in pt:
        new = pt.replace(
            "两者在监测对象、数据量与评价指标上互补：文献[12]解决“看得准”，本文解决“传得省、判得稳、可追溯”。",
            "两者在监测对象、数据量与评价指标上互补：文献[12]侧重缺陷识别的精度，"
            "本文侧重模拟量数据的传输效率、判据稳健性与报文的可追溯性。")
        set_text_keep_style(p, new)
        log.append("已修正定量对照段措辞")
        break

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join(log) if log else "无修改")
