# -*- coding: utf-8 -*-
"""第7轮收尾2：1 043 → 1 042（摘要/英摘/结论）"""
import zipfile, os, shutil
from lxml import etree
SRC = r'D:/驭弓大师/03_论文打磨版_驭弓大师.docx'
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
shutil.copy2(SRC, SRC.replace('.docx', '_第7轮修改前备份2.docx'))
zin = zipfile.ZipFile(SRC, 'r')
parts = {n: zin.read(n) for n in zin.namelist()}
zin.close()
doc = etree.fromstring(parts['word/document.xml'])
paras = doc.findall('.//w:p', NS)
def ptext(p): return ''.join(n.text or '' for n in p.findall('.//w:t', NS))
def setp(p, s):
    ts = p.findall('.//w:t', NS)
    if not ts: return False
    ts[0].text = s; ts[0].set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    for t in ts[1:]: t.text = ''
    return True
log = []
pairs = [('提前 1 043 s', '提前 1 042 s'), ('by 1 043 s', 'by 1 042 s')]
for p in paras:
    t = ptext(p)
    for o, n in pairs:
        if o in t:
            setp(p, t.replace(o, n)); log.append('替换: %s' % o); break
parts['word/document.xml'] = etree.tostring(doc, xml_declaration=True, encoding='UTF-8', standalone=True)
tmp = SRC + '.tmp'
with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zo:
    for n, d in parts.items(): zo.writestr(n, d)
os.remove(SRC); os.replace(tmp, SRC)
print('完成 %d 项' % len(log))
for x in log: print(' -', x)
