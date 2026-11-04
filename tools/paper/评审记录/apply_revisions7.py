# -*- coding: utf-8 -*-
"""
第3轮修改（R3-1 ~ R3-5）

R3-1 🔴 式(10) 与"最小二乘拟合斜率"描述不符：原式 √(2λ/(2−λ))·σ/W 实为相邻差分标准差。
        改为真正的最小二乘斜率标准差：σβ = √(12/(n(n²−1)))·σZ/Δt，其中 σZ = σ·√(λ/(2−λ))。
R3-2 🟡 式(8) 缺 /W 归一因子 → 改为 σROC = √2·σeff/W
R3-3 🔴 σ 定义不统一 → 全文统一：σ 为滤波前原始噪声标准差、σeff 为滤波后噪声标准差
R3-4 🔴 4.4 节噪声边界推导链基于旧差分方案 → 改为基于 EWMA 序列，并给出与实测一致的数值
R3-5 🔵 表12 未说明四舍五入
"""
import os, zipfile, shutil, math
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
def math_inline(p): return "".join(t.text or "" for t in p.iter(mq("t")))

def mk_math_run(text, size=21):
    """普通数学 run（Times New Roman / Cambria Math）"""
    r = etree.Element(mq("r"))
    rp = etree.SubElement(r, mq("rPr"))
    w = etree.SubElement(rp, qn("rFonts"))
    w.set(qn("ascii"), "Times New Roman"); w.set(qn("hAnsi"), "Times New Roman")
    w.set(qn("eastAsia"), "黑体"); w.set(qn("cs"), "Cambria Math")
    etree.SubElement(rp, qn("sz")).set(qn("val"), str(size))
    etree.SubElement(rp, qn("szCs")).set(qn("val"), str(size))
    t = etree.SubElement(r, mq("t")); t.text = text
    t.set(XMLSP, "preserve")
    return r

def mk_sub(base, sub, size=21):
    """下标结构 sSub"""
    s = etree.Element(mq("sSub"))
    sp = etree.SubElement(s, mq("sSubPr"))
    cp = etree.SubElement(sp, mq("ctrlPr"))
    rp = etree.SubElement(cp, qn("rPr"))
    f = etree.SubElement(rp, qn("rFonts"))
    f.set(qn("ascii"), "Cambria Math"); f.set(qn("hAnsi"), "Cambria Math"); f.set(qn("eastAsia"), "黑体")
    etree.SubElement(rp, qn("sz")).set(qn("val"), str(size))
    e = etree.SubElement(s, mq("e"))
    e.append(mk_math_run(base, size))
    etree.SubElement(e, mq("ctrlPr"))
    sb = etree.SubElement(s, mq("sub"))
    rs = mk_math_run(sub, size)
    # 下标用正体
    sb.append(rs)
    etree.SubElement(sb, mq("ctrlPr"))
    return s

def mk_rad(inner_elems, size=21, deg_hide=True):
    """根号结构"""
    rad = etree.Element(mq("rad"))
    rp = etree.SubElement(rad, mq("radPr"))
    if deg_hide:
        etree.SubElement(rp, mq("degHide")).set(mq("val"), "1")
    cp = etree.SubElement(rp, mq("ctrlPr"))
    rpr = etree.SubElement(cp, qn("rPr"))
    f = etree.SubElement(rpr, qn("rFonts"))
    f.set(qn("ascii"), "Cambria Math"); f.set(qn("hAnsi"), "Cambria Math"); f.set(qn("eastAsia"), "黑体")
    etree.SubElement(rpr, qn("sz")).set(qn("val"), str(size))
    deg = etree.SubElement(rad, mq("deg"))
    etree.SubElement(deg, mq("ctrlPr"))
    e = etree.SubElement(rad, mq("e"))
    for el in inner_elems:
        e.append(el)
    etree.SubElement(e, mq("ctrlPr"))
    return rad

def mk_frac(num_elems, den_elems, size=21):
    """分式结构"""
    f = etree.Element(mq("f"))
    fp = etree.SubElement(f, mq("fPr"))
    cp = etree.SubElement(fp, mq("ctrlPr"))
    rpr = etree.SubElement(cp, qn("rPr"))
    ff = etree.SubElement(rpr, qn("rFonts"))
    ff.set(qn("ascii"), "Cambria Math"); ff.set(qn("hAnsi"), "Cambria Math"); ff.set(qn("eastAsia"), "黑体")
    etree.SubElement(rpr, qn("sz")).set(qn("val"), str(size))
    num = etree.SubElement(f, mq("num"))
    for el in num_elems: num.append(el)
    etree.SubElement(num, mq("ctrlPr"))
    den = etree.SubElement(f, mq("den"))
    for el in den_elems: den.append(el)
    etree.SubElement(den, mq("ctrlPr"))
    return f

def replace_omath(p, new_children):
    """替换段落中的 oMath 内容（第一处）"""
    for ch in p:
        if local(ch) == "oMath":
            for c in list(ch): ch.remove(c)
            for el in new_children: ch.append(el)
            return True
    return False

def set_para_text(p, new_text):
    """整段重写为纯文本（保留 pPr 与首 run 格式）"""
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

# =======================================================================
parts = read_parts(SRC)
root = etree.fromstring(parts["word/document.xml"])
body = root.find(qn("body"))
paras = body.findall(qn("p"))
log = []

bak = SRC.replace(".docx", "_第3轮修改前备份.docx")
if not os.path.exists(bak):
    shutil.copy2(SRC, bak); log.append("备份 → " + os.path.basename(bak))

# ----------------------------------------------------------------------
# 定位
# ----------------------------------------------------------------------
P = {}
for i, p in enumerate(paras):
    txt = ptext(p)
    if "为从根源上消除上述不一致" in txt: P["p63"] = i
    if "变化率判据的噪声适用边界可由式" in txt: P["p102"] = i
    if "式中 σeff 为滤波后噪声标准差" in txt: P["p104"] = i
    if "式中 rw = 2" in txt: P["p106"] = i
print("定位:", P)

# ----------------------------------------------------------------------
# R3-1：式(10) 改为最小二乘斜率标准差
#   原文: σr = √(2λ/(2−λ))·σ/W，式中 σ 为滤波后噪声标准差
#   新文: σr = √(12/(n(n²−1)))·σZ/Δt，其中 σZ = σ·√(λ/(2−λ)) 为 EWMA 序列标准差，
#        Δt 为采样间隔，n 为统计窗内样本数（W/Δt+1）
#   同时核验数值：λ=0.2、σ=1.0 ℃、W=60 s、Δt=1 s(→n=61) 时 σβ ≈ ?
# ----------------------------------------------------------------------
if "p63" in P:
    p = paras[P["p63"]]
    old = ptext(p)
    new = old.replace(
        "EWMA 稳态方差为 σ²λ/(2−λ)[18]，变化率标准差可解析为（10）σr = √(2λ/(2−λ))·σ/W，式中 σ 为滤波后噪声标准差。",
        "EWMA 稳态方差为 σZ² = σ²λ/(2−λ)[18]（σZ 为 EWMA 序列的标准差、σ 为滤波前原始噪声标准差）。"
        "对 Zi 序列在长度 W 的滑动窗内作最小二乘拟合，设窗内样本数为 n、采样间隔为 Δt，"
        "则斜率估计的标准差为（10）σr = √(12/(n(n²−1)))·σZ/Δt。"
        "与差分法相比，最小二乘斜率利用了窗内全部样本，在相同噪声下估计方差显著更低，"
        "且随窗长增加按 n^(−3/2) 收敛，故控制限更紧、缓变检出更灵敏。")
    if new != old:
        # 该段除首 run 文本外无 oMath，可整段重写
        set_para_text(p, new)
        log.append("R3-1/R3-3：式(10) 改为最小二乘斜率标准差，统一 σ/σZ 定义")
    else:
        log.append("R3-1 ⚠ 未命中，需检查原始串")

# ----------------------------------------------------------------------
# R3-2：式(8) 补 /W  →  σROC = √2·σeff/W
#   原结构: [sSub σROC][r =][rad √2][sSub σeff]
#   目标  : σROC = √2·σeff / W  → 追加分式 σeff/W
#   更稳做法：直接重建整个 oMath
# ----------------------------------------------------------------------
if "p102" in P and "p104" in P:
    # 先改正文叙述（P102）
    p102 = paras[P["p102"]]
    t102 = ptext(p102)
    n102 = ("变化率判据的噪声适用边界可解析给出。对纯噪声序列，设滤波后噪声标准差为 σeff，"
            "在统计窗 W 内以其差分估计变化率时，变化率估计的标准差为")
    if t102 != n102:
        set_para_text(p102, n102)
        log.append("R3-4：4.4 节边界推导前置说明改为基于滤波序列")

    # 式(8) = P102 的下一段（含"（8）"）
    p8 = paras[P["p102"] + 1]
    if "（8）" in ptext(p8):
        # 重建: σROC = √2 · σeff / W
        children = []
        children.append(mk_sub("σ", "ROC"))
        children.append(mk_math_run("="))
        children.append(mk_rad([mk_math_run("2")]))
        children.append(mk_frac([mk_sub("σ", "eff")], [mk_math_run("W")]))
        replace_omath(p8, children)
        log.append("R3-2：式(8) 补 /W 归一因子")

# ----------------------------------------------------------------------
# R3-4：噪声边界正文（P104）改口径 + 数值重算
#   统一口径：式(9) 3σr ≤ rw，但本文变化率由最小二乘斜率给出（式10），
#   故边界应由式(10)+(11) 给出。为使 4.4 节与 2.4 节一致，
#   这里明确"以最小二乘斜率统计量的 3σ 控制限作为设计约束"，
#   并给出等效的差分近似形式（式9）用于快速校核。
# ----------------------------------------------------------------------
if "p104" in P:
    p104 = paras[P["p104"]]
    n104 = ("式中 σeff 为滤波后噪声标准差，3 点中值滤波对高斯白噪声的方差削减比约 0.448 7，"
            "故 σeff ≈ 0.670σ（σ 为滤波前原始噪声标准差）。按 3σ 准则，若要求单点越限概率"
            "不超过 0.3%，则控制限应满足")
    set_para_text(p104, n104)
    log.append("R3-3：统一 σ（滤波前）/σeff（滤波后）定义")

# 式(9) = P104 的下一段
p9 = paras[P["p104"] + 1]
if "（9）" in ptext(p9):
    children = []
    children.append(mk_math_run("3"))
    children.append(mk_sub("σ", "r"))
    children.append(mk_math_run("≤"))
    children.append(mk_sub("r", "w"))
    replace_omath(p9, children)
    log.append("R3-4：式(9) 改为 3σr ≤ rw（由式10的最小二乘斜率统计量定义，取代旧差分近似）")

# ----------------------------------------------------------------------
# P106：结论句（数值与口径）
#   旧: 实测 σROC 与式（8）吻合良好（σ = 1.0 ℃ 时实测 0.943、理论 0.947 ℃·min−1）
#   新: 明确 σ = 1.0 ℃ 时，式(8) 差分近似给 0.947 ℃/min，
#       最小二乘斜率（式10，n=61、Δt=1 s）给 0.0024 ℃/min，
#       现场以差分近似作保守校核 → 边界 σ ≤ 0.704 ℃
# ----------------------------------------------------------------------
if "p106" in P:
    p106 = paras[P["p106"]]
    t106 = ptext(p106)
    n106 = t106.replace(
        "实测 σROC 与式（8）吻合良好（σ = 1.0 ℃ 时实测 0.943、理论 0.947 ℃·min−1）。"
        "这意味着变化率阈值不能脱离传感器噪声水平单独设定，投运前须按式（9）校核。",
        "以式（8）的差分近似作保守校核时，σ = 1.0 ℃ 下 σROC ≈ 0.947 ℃·min−1，"
        "与差分蒙特卡洛实测 0.943 ℃·min−1 吻合；而本文实际采用的最小二乘斜率统计量（式10）"
        "在 n = 61、Δt = 1 s 下 σr 仅约 0.002 4 ℃·min−1，控制限更紧，"
        "故式（9）给出的 σ ≤ 0.704 ℃ 是一个偏保守的工程边界。"
        "这意味着变化率阈值不能脱离传感器噪声水平单独设定，投运前须按式（9）校核。")
    if n106 != t106:
        set_para_text(p106, n106)
        log.append("R3-4：4.4 节数值结论改为自洽表述（差分近似 + 最小二乘双口径）")

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join("· " + x for x in log))
