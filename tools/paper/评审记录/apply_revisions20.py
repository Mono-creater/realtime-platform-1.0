# -*- coding: utf-8 -*-
"""
第6轮修改（R6-6 + R6-5）：
- R6-6：#168 图3 说明“变化率通道以 EWMA 序列斜率判趋势” → 与正文 roc=(Zi−Zi−W)/W 差分口径一致
- R6-5：检查图3 标题是否含“斜率”并同步
"""
import zipfile, os, shutil
from lxml import etree

SRC = r'D:/驭弓大师/03_论文打磨版_驭弓大师.docx'
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
shutil.copy2(SRC, SRC.replace('.docx', '_第6轮修改前备份3.docx'))

zin = zipfile.ZipFile(SRC, 'r')
parts = {n: zin.read(n) for n in zin.namelist()}
zin.close()
doc = etree.fromstring(parts['word/document.xml'])
paras = doc.findall('.//w:p', NS)

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

log = []
old = '其中阈值通道以 EWMA 平滑值判越限，变化率通道以 EWMA 序列斜率判趋势，两者共用同一滤波序列。'
new = '其中阈值通道以 EWMA 平滑值判越限，变化率通道以 EWMA 序列在窗口 W 上的差分 roc = (Zi − Zi−W)/W 判趋势，两者共用同一滤波序列。'
for i, p in enumerate(paras):
    t = ptext(p)
    if old in t:
        set_para_text(p, t.replace(old, new))
        log.append('R6-6 #%d 图3说明：斜率 → 差分 roc=(Zi−Zi−W)/W' % i)

# 顺带检查图3 标题段
for i, p in enumerate(paras):
    t = ptext(p)
    if t.strip().startswith('图3') and '斜率' in t:
        set_para_text(p, t.replace('斜率', '差分'))
        log.append('R6-6 #%d 图3标题：斜率 → 差分' % i)

parts['word/document.xml'] = etree.tostring(doc, xml_declaration=True, encoding='UTF-8', standalone=True)
tmp = SRC + '.tmp'
with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zo:
    for n, d in parts.items():
        zo.writestr(n, d)
os.remove(SRC)
os.replace(tmp, SRC)
print('修改完成：')
for x in log:
    print(' -', x)
