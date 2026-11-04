# -*- coding: utf-8 -*-
"""第8轮修改（R8-1 + R8-2）：
R8-1 表9 修正 1 / 2 ℃/min 两行，使其严格可复现
     - 1 ℃/min：EWMA 通道不触发（变化率 1 < rw=2），由阈值通道检出 → 记为“—（不触发）”
     - 2 ℃/min：实测中位 119 s，提前 1653-119 = 1534 s
R8-2 表10 “本文（EWMA）”列 60 → 61 s（第7轮遗漏）
"""
import zipfile, os, shutil
from lxml import etree

SRC = r'D:/驭弓大师/03_论文打磨版_驭弓大师.docx'
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
shutil.copy2(SRC, SRC.replace('.docx', '_第8轮修改前备份.docx'))

zin = zipfile.ZipFile(SRC, 'r')
parts = {n: zin.read(n) for n in zin.namelist()}
zin.close()
doc = etree.fromstring(parts['word/document.xml'])
tbls = doc.findall('.//w:tbl', NS)

def set_cell(tc, s):
    ts = tc.findall('.//w:t', NS)
    if not ts:
        return
    ts[0].text = s
    ts[0].set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    for t in ts[1:]:
        t.text = ''

log = []

# ---------- R8-1 表9 ----------
tb9 = tbls[8]
trs = tb9.findall('w:tr', NS)
for r in trs:
    tcs = r.findall('w:tc', NS)
    rate = ''.join(n.text or '' for n in tcs[0].findall('.//w:t', NS)).strip()
    if rate == '1':
        # 1 ℃/min：EWMA 不触发
        set_cell(tcs[2], '—（不触发）')
        set_cell(tcs[3], '—')
        log.append('表9 1 ℃/min：EWMA 3303 → —（不触发）；提前 0 → —')
    elif rate == '2':
        set_cell(tcs[2], '119')
        set_cell(tcs[3], '1 534')
        log.append('表9 2 ℃/min：EWMA 73 → 119 s；提前 1 580 → 1 534 s')

# 表9 表头第三列名不变；表注补说明
paras = doc.findall('.//w:p', NS)
def ptext(p):
    return ''.join(n.text or '' for n in p.findall('.//w:t', NS))
def setp(p, s):
    ts = p.findall('.//w:t', NS)
    if not ts:
        return False
    ts[0].text = s
    ts[0].set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    for t in ts[1:]:
        t.text = ''
    return True

# ---------- R8-2 表10 ----------
tb10 = tbls[9]
for r in tb10.findall('w:tr', NS):
    tcs = r.findall('w:tc', NS)
    first = ''.join(n.text or '' for n in tcs[0].findall('.//w:t', NS)).strip()
    if first.startswith('本文'):
        c3 = ''.join(n.text or '' for n in tcs[3].findall('.//w:t', NS)).strip()
        c4 = ''.join(n.text or '' for n in tcs[4].findall('.//w:t', NS)).strip()
        if c3 == '60':
            set_cell(tcs[3], '61')
            log.append('表10 本文方法 3 ℃/min：60 → 61 s')
        if c4 == '60':
            set_cell(tcs[4], '61')
            log.append('表10 本文方法 5 ℃/min：60 → 61 s')

parts['word/document.xml'] = etree.tostring(doc, xml_declaration=True, encoding='UTF-8', standalone=True)
tmp = SRC + '.tmp'
with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zo:
    for n, d in parts.items():
        zo.writestr(n, d)
os.remove(SRC)
os.replace(tmp, SRC)
print('完成 %d 项：' % len(log))
for x in log:
    print(' -', x)
