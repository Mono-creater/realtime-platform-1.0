# -*- coding: utf-8 -*-
"""第3轮 修正补丁（R3-1 数值单位勘误）
σr 单位换算：√(12/(n(n²−1)))·σZ/Δt 的结果单位是"℃/s"（Δt 以 s 计），
转 ℃/min 须 ×60。n=61、Δt=1 s 时：
  Var(β)=12·0.1111/(1·61·3720)=3.522e-5 → σ(β)=0.005936 ℃/s = 0.356 ℃/min
  等等，需重算：σZ=0.3333, Δt=1s
  σr = √(12/(61·(61²−1)))·0.3333/1 = √(12/226920)·0.3333
     = √5.2883e-5 · 0.3333 = 0.007272·0.3333 = 0.002424 ℃/s
  ×60 → 0.1454 ℃/min
"""
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
for p in body.iter(qn("p")):
    t = ptext(p)
    if "σr 仅约 0.002 4 ℃·min−1" in t:
        new = t.replace("σr 仅约 0.002 4 ℃·min−1", "σr 仅约 0.145 ℃·min−1")
        set_para_text(p, new)
        log.append("勘误：σr 0.002 4 → 0.145 ℃/min（单位换算）")
    if "在 n = 61、Δt = 1 s 下 σr 仅约 0.002 4 ℃·min−1" in t:
        new = t.replace("在 n = 61、Δt = 1 s 下 σr 仅约 0.002 4 ℃·min−1",
                        "在 n = 61、Δt = 1 s 下 σr ≈ 0.145 ℃·min−1")
        set_para_text(p, new)
        log.append("勘误(2)：σr 数值修正")
parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join("· "+x for x in log) if log else "未命中")
