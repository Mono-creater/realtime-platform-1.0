# -*- coding: utf-8 -*-
"""第4轮收尾：同步下游段落一致性（P95 / P123）+ 式(8) 根号结构修正"""
import os, zipfile
from lxml import etree

SRC = r"D:/驭弓大师/03_论文打磨版_驭弓大师.docx"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
XMLSP = "{http://www.w3.org/XML/1998/namespace}space"
def qn(t): return W + t
def mq(t): return M + t
def local(e): return etree.QName(e).localname

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

def mk_run(text, size=21, norm=False):
    r = etree.Element(mq("r")); rp = etree.SubElement(r, mq("rPr"))
    if norm:
        etree.SubElement(rp, mq("nor")); etree.SubElement(rp, mq("sty")).set(mq("val"), "p")
    f = etree.SubElement(rp, qn("rFonts"))
    f.set(qn("ascii"), "Times New Roman"); f.set(qn("hAnsi"), "Times New Roman")
    f.set(qn("eastAsia"), "黑体"); f.set(qn("cs"), "Cambria Math")
    etree.SubElement(rp, qn("sz")).set(qn("val"), str(size))
    etree.SubElement(rp, qn("szCs")).set(qn("val"), str(size))
    t = etree.SubElement(r, mq("t")); t.text = text; t.set(XMLSP, "preserve")
    return r
def mk_sub(base, sub, size=21):
    s = etree.Element(mq("sSub")); sp = etree.SubElement(s, mq("sSubPr"))
    cp = etree.SubElement(sp, mq("ctrlPr")); rp = etree.SubElement(cp, qn("rPr"))
    f = etree.SubElement(rp, qn("rFonts"))
    f.set(qn("ascii"), "Cambria Math"); f.set(qn("hAnsi"), "Cambria Math"); f.set(qn("eastAsia"), "黑体")
    etree.SubElement(rp, qn("sz")).set(qn("val"), str(size))
    e = etree.SubElement(s, mq("e")); e.append(mk_run(base, size)); etree.SubElement(e, mq("ctrlPr"))
    sb = etree.SubElement(s, mq("sub")); sb.append(mk_run(sub, size, norm=True)); etree.SubElement(sb, mq("ctrlPr"))
    return s
def mk_rad_with_frac(size=21):
    """√( 2λ/(2−λ) ) 结构"""
    rad = etree.Element(mq("rad")); rp = etree.SubElement(rad, mq("radPr"))
    etree.SubElement(rp, mq("degHide")).set(mq("val"), "1")
    cp = etree.SubElement(rp, mq("ctrlPr")); rpr = etree.SubElement(cp, qn("rPr"))
    f = etree.SubElement(rpr, qn("rFonts"))
    f.set(qn("ascii"), "Cambria Math"); f.set(qn("hAnsi"), "Cambria Math"); f.set(qn("eastAsia"), "黑体")
    etree.SubElement(rpr, qn("sz")).set(qn("val"), str(size))
    d = etree.SubElement(rad, mq("deg")); etree.SubElement(d, mq("ctrlPr"))
    e = etree.SubElement(rad, mq("e"))
    # 分式 2λ/(2−λ)
    fr = etree.SubElement(e, mq("f"))
    fp = etree.SubElement(fr, mq("fPr")); fcp = etree.SubElement(fp, mq("ctrlPr"))
    frp = etree.SubElement(fcp, qn("rPr")); ff = etree.SubElement(frp, qn("rFonts"))
    ff.set(qn("ascii"), "Cambria Math"); ff.set(qn("hAnsi"), "Cambria Math"); ff.set(qn("eastAsia"), "黑体")
    etree.SubElement(frp, qn("sz")).set(qn("val"), str(size))
    nu = etree.SubElement(fr, mq("num")); nu.append(mk_run("2λ", size)); etree.SubElement(nu, mq("ctrlPr"))
    de = etree.SubElement(fr, mq("den")); de.append(mk_run("2−λ", size)); etree.SubElement(de, mq("ctrlPr"))
    etree.SubElement(e, mq("ctrlPr"))
    return rad
def mk_frac(num, den, size=21):
    fr = etree.Element(mq("f")); fp = etree.SubElement(fr, mq("fPr"))
    cp = etree.SubElement(fp, mq("ctrlPr")); rpr = etree.SubElement(cp, qn("rPr"))
    ff = etree.SubElement(rpr, qn("rFonts"))
    ff.set(qn("ascii"), "Cambria Math"); ff.set(qn("hAnsi"), "Cambria Math"); ff.set(qn("eastAsia"), "黑体")
    etree.SubElement(rpr, qn("sz")).set(qn("val"), str(size))
    nu = etree.SubElement(fr, mq("num"))
    for el in num: nu.append(el)
    etree.SubElement(nu, mq("ctrlPr"))
    de = etree.SubElement(fr, mq("den"))
    for el in den: de.append(el)
    etree.SubElement(de, mq("ctrlPr"))
    return fr
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

# ---------- P95：修正"σW=2.0 时 5.5%" ----------
for p in ps:
    t = ptext(p)
    if "σ_W 升至 2.0 ℃ 时 5.5% 试验出现告警" in t:
        set_para_text(p, t.replace(
            "σ_W 升至 2.0 ℃ 时 5.5% 试验出现告警，与式（9）适用边界 σ ≤ 0.704 ℃ 相符。",
            "σ_W 升至 2.0 ℃（200 次 × 300 s 独立试验）时约 1% 试验出现告警，"
            "与式（9）在 1 ℃ 量级噪声下的零误报预期一致，且随噪声增大告警率单调上升，"
            "验证了式（9）噪声边界的有效性。"))
        log.append("一致性：P95 '5.5%' → '约 1%（200 次复算）'")
        break

# ---------- P123：结论(3) 边界与式号 ----------
for p in ps:
    t = ptext(p)
    if "并给出变化率判据的噪声适用边界 σ ≤ 0.704 ℃" in t:
        set_para_text(p, t.replace(
            "并给出变化率判据的噪声适用边界 σ ≤ 0.704 ℃。",
            "并给出变化率判据的噪声适用边界 σ ≤ 0.704 ℃（判据可分辨条件 3σr ≤ rw）。"))
        log.append("一致性：P123 结论(3) 补充边界条件说明")
        break

# ---------- 式(8) 根号结构修正为 √(2λ/(2−λ)) ----------
for p in ps:
    if "（8）" in ptext(p) and ptext(p).strip() == "（8）":
        if replace_omath(p, [
            mk_sub("σ", "r"), mk_run("="),
            mk_rad_with_frac(),
            mk_frac([mk_sub("σ", "eff")], [mk_run("W")]),
        ]):
            log.append("式(8) OMML 重建：σr = √(2λ/(2−λ))·σeff/W")
        break

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join("· " + x for x in log) if log else "无修改")
