# -*- coding: utf-8 -*-
"""第3轮 补充修改（R3-5 + 格式统一）：
R3-5：表12 补"分值 = 100 − 扣分合计后四舍五入取整"脚注
格式：正文中"式10"统一为"式（10）"（中文期刊规范）
"""
import os, zipfile, shutil
from lxml import etree

SRC = r"D:/驭弓大师/03_论文打磨版_驭弓大师.docx"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
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
children = list(body)
log = []

# ---------------------------------------------------------------
# 1) 格式统一：正文"式10" → "式（10）"
# ---------------------------------------------------------------
for p in body.iter(qn("p")):
    txt = ptext(p)
    if "（式10）" in txt:
        new = txt.replace("（式10）", "（式（10））").replace("（式（10））", "（式10）")
        # 目标：把"（式10）" 改为 "（式10）" 中文化 => 直接改 "（式10）" 为 "式（10）"
        new = txt.replace("（式10）", "式（10）")
        # 修掉可能的双括号
        new = new.replace("（式（10））", "式（10）")
        if new != txt:
            set_para_text(p, new)
            log.append("格式：式10 → 式（10）")

# ---------------------------------------------------------------
# 2) R3-5：表12 后补脚注
# ---------------------------------------------------------------
tbl12_idx = None
for i, ch in enumerate(children):
    if etree.QName(ch).localname == "tbl":
        txt = "".join(t.text or "" for t in ch.iter(qn("t")))
        if "健康指数与检修建议分级" in txt or ("扣分明细" in txt and "分级" in txt):
            tbl12_idx = i
if tbl12_idx is None:
    print("⚠ 未找到表12")
else:
    # 在表12 之后插入脚注段（若尚无"注："段）
    nxt = children[tbl12_idx + 1] if tbl12_idx + 1 < len(children) else None
    already = nxt is not None and etree.QName(nxt).localname == "p" and ptext(nxt).startswith("注")
    if already:
        print("表12 后已有注段：", ptext(nxt)[:120])
    else:
        # 构造新段落：样式沿用表12 前的图/表注段（找最近的以"注："开头段落）
        proto = None
        for ch in children[:tbl12_idx]:
            if etree.QName(ch).localname == "p" and ptext(ch).startswith("注："):
                proto = ch
        newp = etree.Element(qn("p"))
        if proto is not None and proto.find(qn("pPr")) is not None:
            newp.append(etree.fromstring(etree.tostring(proto.find(qn("pPr")))))
        else:
            pp = etree.SubElement(newp, qn("pPr"))
            j = etree.SubElement(pp, qn("jc")); j.set(qn("val"), "left")
        r = etree.SubElement(newp, qn("r"))
        rp = etree.SubElement(r, qn("rPr"))
        f = etree.SubElement(rp, qn("rFonts"))
        f.set(qn("ascii"), "Times New Roman"); f.set(qn("hAnsi"), "Times New Roman"); f.set(qn("eastAsia"), "宋体")
        etree.SubElement(rp, qn("sz")).set(qn("val"), "18")
        t = etree.SubElement(r, qn("t"))
        t.text = ("注：分值 = 100 − 四项扣分合计后四舍五入取整；"
                  "各项扣分上限 25 分，故健康指数理论下限为 0 分。"
                  "分级边界 85、70、55 分别对应正常、关注、计划检修、立即检修四档。")
        t.set(XMLSP, "preserve")
        children[tbl12_idx + 1].addprevious(newp) if tbl12_idx + 1 < len(children) else body.append(newp)
        log.append("R3-5：表12 补四舍五入与分级边界脚注")

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join("· " + x for x in log) if log else "无修改")
