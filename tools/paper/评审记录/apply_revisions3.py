# -*- coding: utf-8 -*-
"""第三批修改：2.4节技术演进链的衔接与定位明确化"""
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

# P61: 明确"投票方案"为中间方案定位
for p in paras:
    pt = ptext(p)
    if pt.startswith("因此对变化率通道改用时间窗持续性投票确认："):
        new = pt.replace(
            "因此对变化率通道改用时间窗持续性投票确认：",
            "作为过渡方案，对变化率通道可改用时间窗持续性投票确认：")
        new = new.replace(
            "变化率投票仅用于缓变场景的等级抬升。",
            "变化率投票仅用于缓变场景的等级抬升。但投票方案仍存在缺陷：其窗口参数（Tvote、ρ、nmin）"
            "须凭经验设定，且无法给出误报率的解析表达式。")
        set_text_keep_style(p, new)
        log.append("P61 已将投票方案定位为过渡方案")
        break

# P62: 开头加衔接
for p in paras:
    pt = ptext(p)
    if pt.startswith("此外，变化率窗口须与轮询周期解耦："):
        new = pt.replace(
            "此外，变化率窗口须与轮询周期解耦：",
            "为从根源上消除上述不一致并给出可解析的误报控制，本文进一步将变化率统计量统一到 EWMA 序列上。"
            "在此之前，变化率窗口须先与轮询周期解耦：")
        set_text_keep_style(p, new)
        log.append("P62 已加过渡衔接")
        break

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join(log) if log else "无修改")
