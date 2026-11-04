# -*- coding: utf-8 -*-
"""R9-2：修正正文残留的"缩短至 60 s"（应为 61 s）——R7-4 遗漏的一处"""
import zipfile, os, shutil
from lxml import etree

DOCX = r"D:/驭弓大师/03_论文打磨版_驭弓大师.docx"
BAK  = r"D:/驭弓大师/13_专家评审意见/03_论文打磨版_第9轮修改前备份2.docx"
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

shutil.copy2(DOCX, BAK)
print("备份 ->", BAK)

with zipfile.ZipFile(DOCX) as z:
    names = z.namelist()
    data = {n: z.read(n) for n in names}

root = etree.fromstring(data['word/document.xml'])

OLD = "本文方法在零误报约束下将 3 ℃/min 缓变检出时延缩短至 60 s。"
NEW = "本文方法在零误报约束下将 3 ℃/min 缓变检出时延缩短至 61 s。"

hits = 0
for p in root.iter(W + 'p'):
    ts = list(p.iter(W + 't'))
    full = ''.join(t.text or '' for t in ts)
    if OLD in full:
        for t in ts:
            if t.text and OLD in t.text:
                t.text = t.text.replace(OLD, NEW); hits += 1
        if hits == 0:
            new_full = full.replace(OLD, NEW)
            for i, t in enumerate(ts):
                t.text = new_full if i == 0 else ''
            hits += 1

print("替换命中:", hits)
if hits:
    data['word/document.xml'] = etree.tostring(root, xml_declaration=True,
                                               encoding='UTF-8', standalone=True)
    tmp = DOCX + '.tmp'
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
        for n in names:
            z.writestr(n, data[n])
    os.remove(DOCX); os.replace(tmp, DOCX)
    print("已写回:", DOCX, os.path.getsize(DOCX), "bytes")

# 终态复核
with zipfile.ZipFile(DOCX) as z:
    root2 = etree.fromstring(z.read('word/document.xml'))
paras = [''.join(n.text or '' for n in p.iter(W+'t')).strip() for p in root2.iter(W+'p')]
full = '\n'.join(paras)
print("\n--- 终态复核 ---")
print("  '(0/100)…3.7%' 恢复:", '零缺口”（0/100）' in full and '上界为 3.7%' in full)
print("  残留 '(0/50)…3.6%':", '零缺口”（0/50）' in full)
print("  残留 '缩短至 60 s':", '缩短至 60 s' in full)
print("  '缩短至 61 s' 次数:", full.count('缩短至 61 s'))
print("  '61 s' 总次数:", full.count('61 s'))
