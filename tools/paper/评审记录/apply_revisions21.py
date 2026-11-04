# -*- coding: utf-8 -*-
"""第7轮修改（R7-1 收尾）：EWMA 检出时延 60 s → 61 s（实测中位），同步表9、正文、结论
注意：统计窗口 W=60 s 保持不变（#175、#387）。
"""
import zipfile, os, shutil, re
from lxml import etree

SRC = r'D:/驭弓大师/03_论文打磨版_驭弓大师.docx'
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
shutil.copy2(SRC, SRC.replace('.docx', '_第7轮修改前备份.docx'))

zin = zipfile.ZipFile(SRC, 'r')
parts = {n: zin.read(n) for n in zin.namelist()}
zin.close()
doc = etree.fromstring(parts['word/document.xml'])
paras = doc.findall('.//w:p', NS)
tbls = doc.findall('.//w:tbl', NS)

def ptext(p):
    return ''.join(n.text or '' for n in p.findall('.//w:t', NS))
def set_para_text(p, s):
    ts = p.findall('.//w:t', NS)
    if not ts:
        return False
    ts[0].text = s
    ts[0].set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    for t in ts[1:]:
        t.text = ''
    return True
def set_cell(tc, s):
    ts = tc.findall('.//w:t', NS)
    if not ts:
        return
    ts[0].text = s
    ts[0].set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    for t in ts[1:]:
        t.text = ''

log = []

# ---------- 表9：EWMA 列 60→61，提前量 1043→1042 / 603→602 / 273→272 ----------
tb9 = tbls[8]
trs = tb9.findall('w:tr', NS)
for r in range(1, len(trs)):
    tcs = trs[r].findall('w:tc', NS)
    rate = ''.join(n.text or '' for n in tcs[0].findall('.//w:t', NS)).strip()
    ewma_txt = ''.join(n.text or '' for n in tcs[2].findall('.//w:t', NS)).strip()
    adv_txt = ''.join(n.text or '' for n in tcs[3].findall('.//w:t', NS)).strip()
    if ewma_txt == '60':
        set_cell(tcs[2], '61')
        log.append('表9 %s ℃/min: EWMA 60→61 s' % rate)
        # 提前量：threshold - 61
        th = int(''.join(n.text or '' for n in tcs[1].findall('.//w:t', NS)).replace(' ', ''))
        new_adv = th - 61
        set_cell(tcs[3], '{:,}'.format(new_adv).replace(',', ' '))
        log.append('表9 %s ℃/min: 提前量 %s → %d s' % (rate, adv_txt, new_adv))

# ---------- 正文：仅改“检出时延”语境的 60 s ----------
repl = [
    ('由 1 103 s 缩短至 60 s，提前 1 043 s；对 5 ℃/min 缓变，由 663 s 缩短至 60 s。',
     '由 1 103 s 缩短至 61 s，提前 1 042 s；对 5 ℃/min 缓变，由 663 s 缩短至 61 s。'),
    ('60 s 的检出时延是 EWMA 趋势检测所需的确认时间',
     '61 s 的检出时延是 EWMA 趋势检测所需的确认时间'),
    ('注：EWMA 趋势检测的发现时延为 60 s，为确认所需付出的确定性代价。',
     '注：EWMA 趋势检测的发现时延为 61 s，为确认所需付出的确定性代价。'),
    ('纯噪声误报率均为 0、3 ℃/min 发现时延均为 60 s',
     '纯噪声误报率均为 0、3 ℃/min 发现时延均为 61 s'),
    ('将 3 ℃/min 缓变检出时延缩短至 60 s，较传统固定阈值判据的 1 103 s 提前 1 043 s',
     '将 3 ℃/min 缓变检出时延缩短至 61 s，较传统固定阈值判据的 1 103 s 提前 1 042 s'),
]
for p in paras:
    t = ptext(p)
    for old, new in repl:
        if old in t:
            set_para_text(p, t.replace(old, new))
            log.append('正文：%s…' % old[:26])
            break

parts['word/document.xml'] = etree.tostring(doc, xml_declaration=True, encoding='UTF-8', standalone=True)
tmp = SRC + '.tmp'
with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zo:
    for n, d in parts.items():
        zo.writestr(n, d)
os.remove(SRC)
os.replace(tmp, SRC)
print('修改完成，共 %d 项：' % len(log))
for x in log:
    print(' -', x)
