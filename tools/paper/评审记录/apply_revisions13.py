# -*- coding: utf-8 -*-
"""第4轮修改（续）：R4-4 R4-5 R4-10 + 下游一致性"""
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

# ---------- R4-4：表6 脚注统一基线口径 ----------
for p in ps:
    t = ptext(p)
    if "压缩倍数以三通道 100 Hz、32 位浮点全量上传原始波形" in t:
        set_para_text(p,
            "注：压缩倍数以三通道 100 Hz、32 位浮点全量上传原始波形（98.9 MB/d）为对比上限；"
            "若以现场 PLC 可实现的 16 位寄存器逐样本上传为基线（三通道各以约 11 Hz 更新，"
            "每次事务读 3 个寄存器、请求 12 B + 响应 14 B = 26 B，日流量 23.57 MB/d、"
            "等效速率约 2.29 kbit/s），双包协议相对其压缩 18.5 倍，"
            "其中 10 点滑窗降采样（100 Hz → 11 Hz）贡献约 9.1 倍、按需追读贡献约 2.0 倍。"
            "异常率指处于异常状态的轮询周期占比。")
        log.append("R4-4：表6 脚注统一为单一可复算基线（18.5 倍，2.29 kbit/s）")
        break

# ---------- 摘要/结论中"约 19 倍"改为"约 18.5 倍"（保持与脚注一致）----------
for p in ps:
    t = ptext(p)
    if "相对 16 位寄存器逐样本上传约 19 倍" in t:
        set_para_text(p, t.replace("相对 16 位寄存器逐样本上传约 19 倍",
                                   "相对 16 位寄存器逐样本上传约 18.5 倍"))
        log.append("一致性：摘要/结论 '约 19 倍' → '约 18.5 倍'")
    elif "相对 16 位寄存器逐样本上传约 19 倍" not in t and "registers" in t and "19 times" in t:
        pass

# 英文摘要
for p in ps:
    t = ptext(p)
    if "about 19 times" in t:
        set_para_text(p, t.replace("about 19 times", "about 18.5 times"))
        log.append("一致性：英文摘要 'about 19 times' → 'about 18.5 times'")

# ---------- R4-5：表11 口径声明 ----------
for p in ps:
    t = ptext(p)
    if "EWMA 统计窗口与轮询周期的解耦效果如表11 所示" in t:
        set_para_text(p,
            "EWMA 统计窗口与轮询周期的解耦效果如表11 所示。表中 σROC 一列按式（8）计算，"
            "解耦前取 σ = 2.0 ℃、解耦后取 σ = 1.0 ℃（解耦前对应未做滤波一致性处理、"
            "噪声等效放大的原判据口径），两列口径不同，仅用于对比窗口随周期的漂移趋势。"
            "解耦前，等效窗口随轮询周期由 1 000 ms 缩短至 100 ms 而由 71.1 s 收缩至 6.8 s，"
            "判据灵敏度随配置漂移；解耦后窗口在 Δt 跨越 10 倍范围内稳定在 59.1～61.1 s，"
            "与设计的 60 s 窗口一致。")
        log.append("R4-5：表11 声明 σROC 两列口径")
        break

# ---------- R4-10：结论补 Wilson 上界 ----------
for p in ps:
    t = ptext(p)
    if "丢包率估计在 1%～10% 区间平均绝对误差不超过 0.33 百分点" in t:
        set_para_text(p, t.replace(
            "丢包率估计在 1%～10% 区间平均绝对误差不超过 0.33 百分点，突发信道下不超过 3.97 百分点；",
            "丢包率估计在 1%～10% 区间平均绝对误差不超过 0.33 百分点，突发信道下不超过 3.97 百分点；"
            "零缺口场景（0/100）点估计为 0，其 95% 置信上界为 3.7%，可为“链路正常/劣化”提供可考核口径；"))
        log.append("R4-10：结论补 Wilson 零缺口上界 3.7%")
        break

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("\n".join("· " + x for x in log) if log else "无修改")
