# -*- coding: utf-8 -*-
"""
第6轮修改（R6-1）：统一残留的“Lσr 控制限”旧口径
- 2.4 节 #63：将“控制限可由 Lσr（L≈3）直接计算”改为与 δmin=3σr≤rw 一致的表述
- 2.4 节 #65 符号表：删除“L 为控制限系数”，改为 rw 变化率阈值
- 英文摘要 #5：删除 least-squares slope 旧口径，改为 EWMA 滑窗差分，并同步控制限表述
保持公式编号、样式不变（只改 run 文本，不动 oMath）。
"""
import zipfile, os, re, shutil
from lxml import etree

SRC = r'D:/驭弓大师/03_论文打磨版_驭弓大师.docx'
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}

shutil.copy2(SRC, SRC.replace('.docx', '_第6轮修改前备份.docx'))

zin = zipfile.ZipFile(SRC, 'r')
parts = {n: zin.read(n) for n in zin.namelist()}
zin.close()

doc = etree.fromstring(parts['word/document.xml'])
paras = doc.findall('.//w:body/w:p', NS)

def get_text(p):
    return ''.join(n.text or '' for n in p.findall('.//w:t', NS))

def set_para_text(p, new_text):
    """把段落所有 w:t 合并到第一个 run，其余清空，保留第一个 run 的样式"""
    runs = p.findall('.//w:r', NS)
    if not runs:
        return False
    ts = []
    for r in runs:
        ts.extend(r.findall('.//w:t', NS))
    if not ts:
        return False
    ts[0].text = new_text
    ts[0].set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    for t in ts[1:]:
        t.text = ''
    return True

changes = []

# ---------- R6-1a: #63 正文口径 ----------
old_a = '该式给出了变化率统计量的理论离散度，使控制限可由 Lσr（L≈3）直接计算，无需凭经验试凑，是本文相对启发式投票方案的关键改进。'
new_a = '该式给出了变化率统计量的理论离散度：据此可按 3σ 准则确定变化率的可分辨下限 δmin = 3σr，并与工程给定的变化率阈值 rw 比对判定告警（详见 4.4 节式（9）），无需凭经验试凑，是本文相对启发式投票方案的关键改进。'
for i, p in enumerate(paras):
    t = get_text(p)
    if old_a in t:
        set_para_text(p, t.replace(old_a, new_a))
        changes.append('R6-1a #%d 正文 Lσr → δmin' % i)

# ---------- R6-1b: #65 符号表 ----------
old_b = r'λ 为 EWMA 平滑系数；L 为控制限系数。式（6）为本文实现所用的解析式，4.4 节据此给出噪声适用边界。'
new_b = r'λ 为 EWMA 平滑系数；rw 为变化率 warning 阈值（式 9）。式（6）为本文实现所用的解析式，4.4 节据此给出噪声适用边界。'
for i, p in enumerate(paras):
    t = get_text(p)
    if old_b in t:
        set_para_text(p, t.replace(old_b, new_b))
        changes.append('R6-1b #%d 符号表 L → rw' % i)

# ---------- R6-1c: 英文摘要 ----------
old_c = 'the median-filtered sequence is smoothed by an EWMA, Zi = λxi + (1−λ)Zi−1, and the least-squares slope fitted over a sliding window of the EWMA sequence is taken as the rate of change, so that the threshold channel and the rate-of-change channel share the same filtered sequence and the filtering inconsistency is eliminated at the root; the variance of the EWMA sequence, σ²λ/(2−λ), gives an analytically derived standard deviation of the rate of change, and the control limit is computed theoretically as Lσr (L ≈ 3), turning the false-alarm rate from empirical settings into a theoretical quantity.'
new_c = 'the median-filtered sequence is smoothed by an EWMA, Zi = λxi + (1−λ)Zi−1, and the difference of the EWMA sequence over the window W, roc = (Zi − Zi−W)/W, is taken as the rate of change, so that the threshold channel and the rate-of-change channel share the same filtered sequence and the filtering inconsistency is eliminated at the root; since the window span W is far larger than the EWMA time constant 1/λ, the difference variance is Var(roc) ≈ 2σZ²/W² with σZ² = σeff²λ/(2−λ), which yields an analytically derived standard deviation of the rate of change and thus a resolvable lower bound δmin = 3σr that is compared with the engineering rate-of-change threshold rw, turning the false-alarm rate from empirical settings into a theoretical quantity.'
for i, p in enumerate(paras):
    t = get_text(p)
    if old_c in t:
        set_para_text(p, t.replace(old_c, new_c))
        changes.append('R6-1c #%d 英摘 least-squares → EWMA差分' % i)

parts['word/document.xml'] = etree.tostring(doc, xml_declaration=True, encoding='UTF-8', standalone=True)

tmp = SRC + '.tmp'
with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zo:
    for n, d in parts.items():
        zo.writestr(n, d)
os.remove(SRC)
os.replace(tmp, SRC)

print('修改完成，共 %d 项：' % len(changes))
for c in changes:
    print(' -', c)
