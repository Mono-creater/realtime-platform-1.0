# -*- coding: utf-8 -*-
"""R8-5 修正：Wilson 零缺口示例 0/100→0/50, 上界 3.7%→3.6%（与 Wilson 公式一致）"""
import zipfile, os, shutil
from lxml import etree

DOCX = r"D:/驭弓大师/03_论文打磨版_驭弓大师.docx"
BAK  = r"D:/驭弓大师/13_专家评审意见/03_论文打磨版_第8轮修改前备份3.docx"
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

shutil.copy2(DOCX, BAK)
print("备份 ->", BAK)

with zipfile.ZipFile(DOCX) as z:
    names = z.namelist()
    data = {n: z.read(n) for n in names}

root = etree.fromstring(data['word/document.xml'])

OLD = "例如“零缺口”（0/100）的点估计为 0，但 95% 置信区间上界为 3.7%"
NEW = "例如“零缺口”（0/50）的点估计为 0，但 95% 置信区间上界为 3.6%"

hits = 0
for p in root.iter(W + 'p'):
    ts = list(p.iter(W + 't'))
    full = ''.join(t.text or '' for t in ts)
    if OLD in full:
        # 逐 run 替换
        for t in ts:
            if t.text and OLD in t.text:
                t.text = t.text.replace(OLD, NEW); hits += 1
        # 跨 run 情形：整段重写首个 run
        if hits == 0:
            # 定位：把整段文本重写到第一个 run，其余清空
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
    os.remove(DOCX)
    os.replace(tmp, DOCX)
    print("已写回:", DOCX, os.path.getsize(DOCX), "bytes")
else:
    print("未命中！")
