# -*- coding: utf-8 -*-
"""
第3轮 补丁B：修复 4.4 节推导链断裂

问题：式(8) 用 σROC（差分口径），式(9) 却写 3σr（最小二乘口径），
      读者无法从式(8) 推出式(9)，属逻辑断裂。

修复：4.4 节统一以"滤波序列差分估计"这一保守口径推导，
      推出 σROC = √2·σeff/W（式8）
      → 3σROC ≤ rw（式9）
      并说明：本文实际实现采用最小二乘斜率（式10），其 σr 更小，
      故由式(9) 得到的噪声边界 σ ≤ 0.704 ℃ 是偏保守的工程边界。
"""
import os, zipfile
from lxml import etree

SRC = r"D:/驭弓大师/03_论文打磨版_驭弓大师.docx"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
XMLSP = "{http://www.w3.org/XML/1998/namespace}space"
def qn(t): return W + t
def mq(t): return M + t
def local(e): return etree.QName(e).localname

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
def mtxt(p): return "".join(t.text or "" for t in p.iter(mq("t")))
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

def mk_run(text, size=21, norm=False):
    r = etree.Element(mq("r"))
    rp = etree.SubElement(r, mq("rPr"))
    if norm:
        etree.SubElement(rp, mq("nor"))
        etree.SubElement(rp, mq("sty")).set(mq("val"), "p")
    w = etree.SubElement(rp, qn("rFonts"))
    w.set(qn("ascii"), "Times New Roman"); w.set(qn("hAnsi"), "Times New Roman")
    w.set(qn("eastAsia"), "黑体"); w.set(qn("cs"), "Cambria Math")
    etree.SubElement(rp, qn("sz")).set(qn("val"), str(size))
    etree.SubElement(rp, qn("szCs")).set(qn("val"), str(size))
    t = etree.SubElement(r, mq("t")); t.text = text
    t.set(XMLSP, "preserve")
    return r

def mk_sub(base, sub, size=21):
    s = etree.Element(mq("sSub"))
    sp = etree.SubElement(s, mq("sSubPr"))
    cp = etree.SubElement(sp, mq("ctrlPr"))
    rp = etree.SubElement(cp, qn("rPr"))
    f = etree.SubElement(rp, qn("rFonts"))
    f.set(qn("ascii"), "Cambria Math"); f.set(qn("hAnsi"), "Cambria Math"); f.set(qn("eastAsia"), "黑体")
    etree.SubElement(rp, qn("sz")).set(qn("val"), str(size))
    e = etree.SubElement(s, mq("e"))
    e.append(mk_run(base, size)); etree.SubElement(e, mq("ctrlPr"))
    sb = etree.SubElement(s, mq("sub"))
    sb.append(mk_run(sub, size, norm=True)); etree.SubElement(sb, mq("ctrlPr"))
    return s

def mk_rad(inner, size=21):
    rad = etree.Element(mq("rad"))
    rp = etree.SubElement(rad, mq("radPr"))
    etree.SubElement(rp, mq("degHide")).set(mq("val"), "1")
    cp = etree.SubElement(rp, mq("ctrlPr"))
    rpr = etree.SubElement(cp, qn("rPr"))
    f = etree.SubElement(rpr, qn("rFonts"))
    f.set(qn("ascii"), "Cambria Math"); f.set(qn("hAnsi"), "Cambria Math"); f.set(qn("eastAsia"), "黑体")
    etree.SubElement(rpr, qn("sz")).set(qn("val"), str(size))
    deg = etree.SubElement(rad, mq("deg")); etree.SubElement(deg, mq("ctrlPr"))
    e = etree.SubElement(rad, mq("e"))
    for el in inner: e.append(el)
    etree.SubElement(e, mq("ctrlPr"))
    return rad

def mk_frac(num, den, size=21):
    f = etree.Element(mq("f"))
    fp = etree.SubElement(f, mq("fPr"))
    cp = etree.SubElement(fp, mq("ctrlPr"))
    rpr = etree.SubElement(cp, qn("rPr"))
    ff = etree.SubElement(rpr, qn("rFonts"))
    ff.set(qn("ascii"), "Cambria Math"); ff.set(qn("hAnsi"), "Cambria Math"); ff.set(qn("eastAsia"), "黑体")
    etree.SubElement(rpr, qn("sz")).set(qn("val"), str(size))
    nu = etree.SubElement(f, mq("num"))
    for el in num: nu.append(el)
    etree.SubElement(nu, mq("ctrlPr"))
    de = etree.SubElement(f, mq("den"))
    for el in den: de.append(el)
    etree.SubElement(de, mq("ctrlPr"))
    return f

def replace_omath(p, children):
    for ch in p:
        if local(ch) == "oMath":
            for c in list(ch): ch.remove(c)
            for el in children: ch.append(el)
            return True
    return False

parts = read_parts(SRC)
root = etree.fromstring(parts["word/document.xml"])
body = root.find(qn("body"))
ps = body.findall(qn("p"))
log = []

# 定位
i8 = i9 = None
for i, p in enumerate(ps):
    t = ptext(p)
    if t.strip().endswith("（8）") and mtxt(p).startswith("σROC"): i8 = i
    if t.strip().endswith("（9）") and mtxt(p).startswith("3σr"): i9 = i
print("式(8)@P%d, 式(9)@P%d" % (i8, i9))

# 式(9) 改回 3σROC ≤ rw（与式8同口径），并补充说明
if i9 is not None:
    p9 = ps[i9]
    children = [
        mk_run("3"), mk_sub("σ", "ROC"),
        mk_run("≤"),
        mk_sub("r", "w"),
    ]
    replace_omath(p9, children)
    log.append("修复：式(9) 改为 3σROC ≤ rw，与式(8) 同口径")

# P104 补充说明式(9) 与式(10) 的关系
if i9 is not None:
    p104 = ps[i9 - 1]
    t = ptext(p104)
    if "3σ 准则" in t:
        n = t.replace(
            "按 3σ 准则，若要求单点越限概率不超过 0.3%，则控制限应满足",
            "按 3σ 准则，若要求单点越限概率不超过 0.3%，则控制限应满足")
        # 追加一句交代两式关系
        n = n.rstrip("。") + "。"
        if "该式即实际实现的保守上界" not in n:
            n = n + "该式以相邻差分估计变化率，是 2.4 节最小二乘斜率统计量的保守上界。"
        if n != t:
            set_para_text(p104, n)
            log.append("修复：4.4 节说明式(8) 是式(10) 的保守上界")

# P106 调整措辞（已改过一次，这里统一为"式(9) 由式(8) 推出，用于保守校核"）
if i9 is not None:
    p106 = ps[i9 + 1]
    t = ptext(p106)
    n = t.replace(
        "以式（8）的差分近似作保守校核时，σ = 1.0 ℃ 下 σROC ≈ 0.947 ℃·min−1，"
        "与差分蒙特卡洛实测 0.943 ℃·min−1 吻合；而本文实际采用的最小二乘斜率统计量式（10）"
        "在 n = 61、Δt = 1 s 下 σr ≈ 0.145 ℃·min−1，控制限更紧，"
        "故式（9）给出的 σ ≤ 0.704 ℃ 是一个偏保守的工程边界。"
        "这意味着",
        "式（8）的差分估计经蒙特卡洛验证（σ = 1.0 ℃ 时实测 0.943、理论 0.947 ℃·min−1），"
        "由式（9）反解得到的噪声边界为 σ ≤ 0.704 ℃。由于本文实际实现的最小二乘斜率统计量"
        "（式10，n = 61、Δt = 1 s 时 σr ≈ 0.145 ℃·min−1）标准差更小、控制限更紧，"
        "该边界对本文实现而言偏保守。这意味着")
    if n != t:
        set_para_text(p106, n)
        log.append("修复：4.4 节结论句逻辑链重排")

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join("· " + x for x in log) if log else "无修改")
