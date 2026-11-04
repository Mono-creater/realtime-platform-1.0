# -*- coding: utf-8 -*-
"""第二批修改：M4 创新界定 + M3 公式编号对调"""
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

# ---- M4: 创新界定 ----
for p in paras:
    pt = ptext(p)
    if "据此变化率控制限按 Lσr 理论计算" in pt and "使误报率由经验设定转为可理论计算" in pt:
        new = pt.replace(
            "使误报率由经验设定转为可理论计算。",
            "使误报率由经验设定转为可理论计算。需说明的是，EWMA 本身是 1959 年提出的经典统计工具[18]，"
            "经典应用将其直接作用于原始观测序列；本文的贡献不在于引入 EWMA，而在于将其作为"
            "阈值通道与变化率通道共用的唯一滤波序列，从机理上消除两通道滤波不一致，"
            "并据此给出可解析的变化率控制限，而非对经典方法的简单套用。")
        set_text_keep_style(p, new)
        log.append("M4 已补创新界定")
        break

# ---- M3: 公式编号对调 (P80的(13)->(12), P86的(12)->(13)) ----
# 先改 P86 的 （12）->（13） 防止冲突
for p in paras:
    pt = ptext(p)
    if "（12）p̂ ± z·√(p̂(1−p̂)/n" in pt:
        set_text_keep_style(p, pt.replace("（12）p̂ ± z·√(p̂(1−p̂)/n", "（13）p̂ ± z·√(p̂(1−p̂)/n"))
        log.append("M3 Wilson公式 (12)->(13)")
        break
for p in paras:
    pt = ptext(p)
    if "平均带宽（13）B = 31·" in pt:
        set_text_keep_style(p, pt.replace("平均带宽（13）B = 31·", "平均带宽（12）B = 31·"))
        log.append("M3 带宽公式 (13)->(12)")
        break

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join(log) if log else "无修改")
