# -*- coding: utf-8 -*-
"""第5轮修改：修复 R5-1 R5-2 R5-3

R5-3（公式编号断裂）：
  现状：2.4 节 σr 公式行内编号 (10)，4.4 节同一公式独立编号 (8) —— 重复且断裂。
  修正：
    - 2.4 节 σr 公式：行内"（10）σr = ..." 改为正式独立公式段，编号 (8)
    - 4.4 节：删除重复的 (8) 独立公式段，文中改为"由式（8）"
    - 4.4 节 δmin 公式：编号 (9) 保留
    - 3.2 节 RUL：(11) → (10)
    - 4.2 节 带宽：(12) → (11)
    - 4.3 节 Wilson：(13) → (12)
R5-1：表11 口径声明改为直接说明"表中以 σeff 计入"，与式(8) 定义对齐
R5-2：P82 "2.678 MB/d" → "2.554 MB/d"
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
def set_run_only(p, s):
    """仅改段落中第一个 w:r 的文本（用于公式编号段）"""
    for r in p.findall(qn("r")):
        for t in r.findall(qn("t")):
            if t.text and t.text.strip():
                t.text = s; t.set(XMLSP, "preserve"); return True
    return False

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
def mk_rad_frac(size=21):
    rad = etree.Element(mq("rad")); rp = etree.SubElement(rad, mq("radPr"))
    etree.SubElement(rp, mq("degHide")).set(mq("val"), "1")
    cp = etree.SubElement(rp, mq("ctrlPr")); rpr = etree.SubElement(cp, qn("rPr"))
    f = etree.SubElement(rpr, qn("rFonts"))
    f.set(qn("ascii"), "Cambria Math"); f.set(qn("hAnsi"), "Cambria Math"); f.set(qn("eastAsia"), "黑体")
    etree.SubElement(rpr, qn("sz")).set(qn("val"), str(size))
    d = etree.SubElement(rad, mq("deg")); etree.SubElement(d, mq("ctrlPr"))
    e = etree.SubElement(rad, mq("e"))
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

parts = read_parts(SRC)
root = etree.fromstring(parts["word/document.xml"])
body = root.find(qn("body"))
ps = body.findall(qn("p"))
log = []

# ============ 1) 2.4 节：σr 行内编号 (10) → 拆出独立公式段 (8) ============
i63 = None
for i, p in enumerate(ps):
    if "为从根源上消除上述不一致" in ptext(p): i63 = i; break
if i63 is not None:
    t = ptext(ps[i63])
    new_t = t.replace(
        "故变化率的标准差可解析为（10）σr = √(2λ/(2−λ))·σeff/W。",
        "故变化率的标准差可解析为式（8）。")
    new_t = new_t.replace("该式给出了变化率统计量的理论离散度", "该式给出了变化率统计量的理论离散度")
    set_para_text(ps[i63], new_t)
    # 在该段后插入独立公式段：式(8) σr = √(2λ/(2−λ))·σeff/W
    proto = ps[i63]
    newp = etree.Element(qn("p"))
    if proto.find(qn("pPr")) is not None:
        newp.append(etree.fromstring(etree.tostring(proto.find(qn("pPr")))))
    # 居中
    pPr = newp.find(qn("pPr"))
    for c in list(pPr):
        if local(c) == "jc": pPr.remove(c)
    jc = etree.SubElement(pPr, qn("jc")); jc.set(qn("val"), "center")
    om = etree.SubElement(newp, mq("oMath"))
    om.append(mk_sub("σ", "r")); om.append(mk_run("="))
    om.append(mk_rad_frac())
    om.append(mk_frac([mk_sub("σ", "eff")], [mk_run("W")]))
    rnum = etree.SubElement(newp, qn("r"))
    tr = etree.SubElement(rnum, qn("t")); tr.text = "　　（8）"; tr.set(XMLSP, "preserve")
    ps[i63].addnext(newp)
    log.append("R5-3：2.4 节 σr 提为独立公式 (8)，正文改为'可解析为式（8）'")
    ps = body.findall(qn("p"))

# ============ 2) 4.4 节：删除重复的 (8) 独立公式段，正文改引用 ============
i102 = None
for i, p in enumerate(ps):
    if "变化率判据的噪声适用边界" in ptext(p): i102 = i; break
if i102 is not None:
    set_para_text(ps[i102],
        "变化率判据的噪声适用边界可由式（8）导出。对纯噪声序列，将滤波后噪声标准差 σeff 代入式（8），"
        "变化率估计的标准差为")
    # 下一个段落（原 (8) 独立公式）→ 删除
    p8 = ps[i102 + 1]
    if ptext(p8).strip() == "（8）" or ptext(p8).strip().endswith("（8）"):
        body.remove(p8)
        log.append("R5-3：删除 4.4 节重复的 (8) 公式段")
        ps = body.findall(qn("p"))

# 重新定位并修正 4.4 节说明句与式(9)
i102 = None
for i, p in enumerate(ps):
    if "变化率判据的噪声适用边界" in ptext(p): i102 = i; break
if i102 is not None:
    set_para_text(ps[i102 + 1],
        "式中 σeff 为滤波后噪声标准差（3 点中值滤波对高斯白噪声的方差削减比约 0.448 7，"
        "故 σeff ≈ 0.670σ，σ 为滤波前原始噪声标准差）。该式与固定窗差分的蒙特卡洛复算一致："
        "λ = 0.2、W = 1 min、σ = 1.0 ℃ 时解析 σr ≈ 0.316 ℃·min⁻¹，实测 0.315 ℃·min⁻¹。"
        "按 3σ 准则，变化率统计量在纯噪声下的可分辨下限为式（9）：")
    log.append("R5-3：4.4 节说明句编号同步为式(8)/(9)")

# ============ 3) 公式编号顺延：(11)->(10)，(12)->(11)，(13)->(12) ============
for p in ps:
    t = ptext(p)
    n = t
    if "（11）RUL = (xth − xnow)/β" in n:
        n = n.replace("（11）RUL = (xth − xnow)/β", "（10）RUL = (xth − xnow)/β")
        set_para_text(p, n); log.append("R5-3：RUL 编号 (11)→(10)")
    elif "平均带宽（12）B = 31" in n:
        n = n.replace("平均带宽（12）B = 31", "平均带宽（11）B = 31")
        set_para_text(p, n); log.append("R5-3：带宽编号 (12)→(11)")
    elif "置信区间：（13）(p̂" in n:
        n = n.replace("置信区间：（13）(p̂", "置信区间：（12）(p̂")
        set_para_text(p, n); log.append("R5-3：Wilson 编号 (13)→(12)")

# ============ 4) 符号约定段：式10 → 式（8）；补 σeff 口径 ============
for p in ps:
    t = ptext(p)
    if t.startswith("本节符号约定"):
        set_para_text(p,
            "本节符号约定：σ 为滤波前原始传感器噪声标准差；σeff 为经 3 点中值滤波后的噪声标准差"
            "（σeff ≈ 0.670σ）；σZ 为 EWMA 序列的标准差（σZ² = σeff²λ/(2−λ)）；"
            "σr 为变化率统计量的标准差（式8）；W 为变化率窗口（min）；Δt 为轮询/采样间隔（s）；"
            "n 为窗内样本数；λ 为 EWMA 平滑系数；L 为控制限系数。"
            "式（8）为本文实现所用的解析式，4.4 节据此给出噪声适用边界。")
        log.append("R5-3：符号约定段 式10 → 式（8）")
        break

# ============ 5) R5-2：2.678 → 2.554 ============
for p in ps:
    t = ptext(p)
    if "较固定 1 s 周期（2.678 MB/d）节省带宽" in t:
        set_para_text(p, t.replace("较固定 1 s 周期（2.678 MB/d）节省带宽",
                                   "较固定 1 s 周期（2.554 MB/d）节省带宽"))
        log.append("R5-2：2.678 → 2.554 MB/d")
        break

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join("· " + x for x in log) if log else "无修改")
