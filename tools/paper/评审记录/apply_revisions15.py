# -*- coding: utf-8 -*-
"""第4轮精确修正：
(1) 噪声边界 σ ≤ 0.704 → σ ≤ 2.11 ℃
(2) 表11 口径声明改为 σ=3.0（解耦前）/ σ=2.0（解耦后）
"""
import os, zipfile
from lxml import etree

SRC = r"D:/驭弓大师/03_论文打磨版_驭弓大师.docx"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
XMLSP = "{http://www.w3.org/XML/1998/namespace}space"
def qn(t): return W + t

def read_parts(p):
    z = zipfile.ZipFile(p); d = {n: z.read(n) for n in z.namelist()}; z.close(); return d
def write_parts(parts, dst):
    tmp = dst + ".tmp"
    z = zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED)
    for n, data in parts.items(): z.writestr(n, data)
    z.close()
    if os.path.exists(dst): os.remove(dst)
    os.replace(tmp, dst)
def ptext(p): return "".join(t.text or "" for t in p.iter(qn("t")))
def set_para_text(p, s):
    pPr = p.find(qn("pPr"))
    for ch in list(p):
        if ch is not pPr: p.remove(ch)
    r = etree.SubElement(p, qn("r"))
    rp = etree.SubElement(r, qn("rPr"))
    f = etree.SubElement(rp, qn("rFonts"))
    f.set(qn("ascii"), "Times New Roman"); f.set(qn("hAnsi"), "Times New Roman"); f.set(qn("eastAsia"), "宋体")
    t = etree.SubElement(r, qn("t")); t.text = s
    t.set(XMLSP, "preserve")
    return True

parts = read_parts(SRC)
root = etree.fromstring(parts["word/document.xml"])
body = root.find(qn("body"))
ps = body.findall(qn("p"))
log = []

# (1) 4.4 节结论句：边界 σ ≤ 0.704 → 2.11
for p in ps:
    t = ptext(p)
    if "保证判据可分辨的噪声边界为 σ ≤ 0.704 ℃" in t:
        set_para_text(p, t.replace(
            "由 δmin ≤ rw 反解，保证判据可分辨的噪声边界为 σ ≤ 0.704 ℃；"
            "当 σW = 2.0 ℃ 时 δmin ≈ 1.9 ℃·min⁻¹ 已接近 rw，"
            "对应 200 次独立试验中约 1% 出现告警，与统计预期一致。",
            "由 δmin ≤ rw 反解，保证判据可分辨的噪声边界为 σ ≤ 2.11 ℃；"
            "当 σW = 2.0 ℃ 时 δmin ≈ 1.9 ℃·min⁻¹ 仍低于 rw，"
            "200 次独立试验中仅约 1% 出现告警，与零误报预期一致。"))
        log.append("修正：4.4 节噪声边界 σ ≤ 0.704 → 2.11 ℃")
        break

# (2) 结论(3)：边界同样更正
for p in ps:
    t = ptext(p)
    if "并给出变化率判据的噪声适用边界 σ ≤ 0.704 ℃" in t:
        set_para_text(p, t.replace(
            "并给出变化率判据的噪声适用边界 σ ≤ 0.704 ℃（判据可分辨条件 3σr ≤ rw）。",
            "并给出变化率判据的噪声适用边界 σ ≤ 2.11 ℃（判据可分辨条件 3σr ≤ rw）。"))
        log.append("修正：结论(3) 边界 → 2.11 ℃")
        break

# (3) 表11 声明口径更正为 σ=3.0/σ=2.0
for p in ps:
    t = ptext(p)
    if "表中 σROC 一列按式（8）计算" in t:
        set_para_text(p, t.replace(
            "表中 σROC 一列按式（8）计算，解耦前取 σ = 2.0 ℃、解耦后取 σ = 1.0 ℃"
            "（解耦前对应未做滤波一致性处理、噪声等效放大的原判据口径），"
            "两列口径不同，仅用于对比窗口随周期的漂移趋势。",
            "表中 σROC 一列按式（8）计算：解耦前取 σ = 3.0 ℃（对应未做滤波一致性处理时"
            "有效噪声被放大的原判据口径），解耦后取 σ = 2.0 ℃（本文方法口径），"
            "两列口径相差 1.5 倍，仅用于对比等效窗口随轮询周期的漂移趋势。"))
        log.append("修正：表11 口径声明 → σ=3.0（前）/σ=2.0（后）")
        break

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join("· " + x for x in log) if log else "无修改")
