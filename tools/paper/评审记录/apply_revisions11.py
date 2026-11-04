# -*- coding: utf-8 -*-
"""第3轮 补丁C：文字润色 + 格式统一（式10 → 式（10））"""
import os, zipfile
from lxml import etree

SRC = r"D:/驭弓大师/03_论文打磨版_驭弓大师.docx"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
XMLSP = "{http://www.w3.org/XML/1998/namespace}space"
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
def ptext(p): return "".join(t.text or "" for t in p.iter(qn("t")))
def set_para_text(p, new_text):
    pPr = p.find(qn("pPr"))
    for ch in list(p):
        if ch is not pPr: p.remove(ch)
    r = etree.SubElement(p, qn("r"))
    rp = etree.SubElement(r, qn("rPr"))
    f = etree.SubElement(rp, qn("rFonts"))
    f.set(qn("ascii"), "Times New Roman"); f.set(qn("hAnsi"), "Times New Roman"); f.set(qn("eastAsia"), "宋体")
    t = etree.SubElement(r, qn("t")); t.text = new_text
    t.set(XMLSP, "preserve")
    return True

parts = read_parts(SRC)
root = etree.fromstring(parts["word/document.xml"])
body = root.find(qn("body"))
log = []
for p in list(body.iter(qn("p"))):
    t = ptext(p)
    n = t
    # 1) 润色 P104 句末
    n = n.replace(
        "按 3σ 准则，若要求单点越限概率不超过 0.3%，则控制限应满足。该式以相邻差分估计变化率，是 2.4 节最小二乘斜率统计量的保守上界。",
        "按 3σ 准则，若要求单点越限概率不超过 0.3%，则控制限应满足。该式以相邻差分估计变化率，"
        "其标准差略高于 2.4 节最小二乘斜率统计量，故作为保守上界使用。")
    # 2) 格式：式10 → 式（10）
    n = n.replace("（式10，", "（式（10），").replace("式10）", "式（10））")
    n = n.replace("式10，", "式（10），")
    n = n.replace("式（式（10），", "（式（10），")
    if n != t:
        set_para_text(p, n)
        log.append("润色/格式：" + t[:30])

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join("· " + x for x in log) if log else "无修改")
