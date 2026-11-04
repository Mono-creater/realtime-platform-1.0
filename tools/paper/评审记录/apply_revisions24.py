# -*- coding: utf-8 -*-
"""第8轮修改（R8-3）：健康指数扣分公式与表12 对齐
表12 实测规律：
  pF = min(25, 0.5·|F̄ − Ft|)          （力偏离，N）
  pσ = min(25, 0.8·σF)                （波动标准差，N）
  pT = min(25, 2.5·max(0, Tmax − Tlim))  （Tlim = 80 ℃）
  pA = min(25, 2.5·N24h)              （24 h 告警数）
"""
import zipfile, os, shutil
from lxml import etree

SRC = r'D:/驭弓大师/03_论文打磨版_驭弓大师.docx'
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
shutil.copy2(SRC, SRC.replace('.docx', '_第8轮修改前备份2.docx'))

zin = zipfile.ZipFile(SRC, 'r')
parts = {n: zin.read(n) for n in zin.namelist()}
zin.close()
doc = etree.fromstring(parts['word/document.xml'])
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

old = ('pF = min(25, 0.5·|F̄ − Ft|/Ft×100)，pσ = min(25, 0.8·σF/Ft×100)，'
       'pT = min(25, 2.5·max(0, Tmax − Tlim))，pA = min(25, N24h/10×25)。')
new = ('pF = min(25, 0.5·|F̄ − Ft|)，pσ = min(25, 0.8·σF)，'
       'pT = min(25, 2.5·max(0, Tmax − Tlim))，pA = min(25, 2.5·N24h)，'
       '式中 F̄ 为接触力均值、Ft 为接触力目标值，σF 为接触力波动标准差，'
       'Tmax 为 24 h 温度峰值、Tlim = 80 ℃ 为温度上限，N24h 为 24 h 告警数；'
       '各项扣分以 25 分为上限、量纲均为分值。')
log = []
for p in paras:
    t = ptext(p)
    if old in t:
        setp(p, t.replace(old, new))
        log.append('R8-3 健康指数扣分公式与表12 对齐')
        break

parts['word/document.xml'] = etree.tostring(doc, xml_declaration=True, encoding='UTF-8', standalone=True)
tmp = SRC + '.tmp'
with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zo:
    for n, d in parts.items():
        zo.writestr(n, d)
os.remove(SRC)
os.replace(tmp, SRC)
print('完成 %d 项' % len(log))
for x in log:
    print(' -', x)
