# -*- coding: utf-8 -*-
"""第5轮修正B：公式编号重排（按正文出现顺序）
  roc(5) → σr(6) → H(7) → MTTR(8) → δmin(9) → RUL(10) → B(11) → Wilson(12)
"""
import os, zipfile, re
from lxml import etree

SRC = r"D:/驭弓大师/03_论文打磨版_驭弓大师.docx"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
XMLSP = "{http://www.w3.org/XML/1998/namespace}space"
def qn(t): return W + t
def mq(t): return M + t

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
def fix_num(p, new_num):
    """改段落中的公式编号（形如 XXXX（N））"""
    for r in p.findall(qn("r")):
        for t in r.findall(qn("t")):
            if t.text and "（" in t.text and re.search(r'（\d+）', t.text):
                t.text = re.sub(r'（\d+）', new_num, t.text)
                t.set(XMLSP, "preserve"); return True
    return False

parts = read_parts(SRC)
root = etree.fromstring(parts["word/document.xml"])
body = root.find(qn("body"))
ps = body.findall(qn("p"))
log = []

# 映射：旧号 → 新号
# σr: (8)→(6) ; H: (6)→(7) ; MTTR: (7)→(8) ; δmin:(9) 保持 ; RUL:(10) 保持 ; B:(11) 保持 ; Wilson:(12) 保持
# 注意 H 与 MTTR 的正文引用"按式（6）计算"要同步

for i, p in enumerate(ps):
    t = ptext(p)
    fm = "".join(x.text or "" for x in p.iter(mq("t")))

    # σr 独立公式段: 旧(8) → 新(6)
    if "σr" in fm and "（8）" in t:
        fix_num(p, "（6）"); log.append("σr: (8)→(6)")

    # H 独立公式段: 旧(6) → 新(7)
    elif fm.startswith("H=100") and "（6）" in t:
        fix_num(p, "（7）"); log.append("H: (6)→(7)")

    # MTTR 独立公式段: 旧(7) → 新(8)
    elif "MTTR" in fm and "（7）" in t:
        fix_num(p, "（8）"); log.append("MTTR: (7)→(8)")

# 正文引用同步
for p in ps:
    t = ptext(p)
    n = t
    # 2.4 节"可解析为式（8）" → 式（6）
    if "故变化率的标准差可解析为式（8）" in n:
        n = n.replace("故变化率的标准差可解析为式（8）", "故变化率的标准差可解析为式（6）")
    # 符号约定段 式8 → 式6
    if n.startswith("本节符号约定"):
        n = n.replace("（式8）", "（式6）").replace("式（8）为本文实现", "式（6）为本文实现")
    # 3.2 节"按式（6）计算" → 式（7）
    if "按式（6）计算" in n and "健康指数代理指标" in n:
        n = n.replace("按式（6）计算", "按式（7）计算")
    # 4.4 节 式(8)→式(6)
    if "变化率判据的噪声适用边界可由式（8）导出" in n:
        n = n.replace("变化率判据的噪声适用边界可由式（8）导出", "变化率判据的噪声适用边界可由式（6）导出")
        n = n.replace("代入式（8）", "代入式（6）")
    if n != t:
        set_para_text(p, n); log.append("引用同步: " + t[:36])

# P109 表11 说明 "按式（8）计算" → 式（6）
for p in ps:
    t = ptext(p)
    if "表中 σROC 一列按式（8）计算" in t:
        set_para_text(p, t.replace("表中 σROC 一列按式（8）计算", "表中 σROC 一列按式（6）计算"))
        log.append("表11 说明: 式(8)→式(6)")
        break

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join("· " + x for x in log) if log else "无修改")
