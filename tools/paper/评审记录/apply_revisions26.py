# -*- coding: utf-8 -*-
"""
R8-5 撤回（R9-1）—— 恢复论文原文的 Wilson 零缺口示例

背景：第八轮"全量复算"中，我以一段有缺陷的 Python 实现（Wilson 上界公式的
      sqrt 内项漏除 n²）得出"0/100 → 1.87%、3.7% 对应 0/50"的错误结论，
      并据此把论文改成"（0/50）… 上界 3.6%"。

复核（标准 Wilson score 区间，与论文式(12) 完全一致）：
      [p̂ + z²/(2n) ± z·√( p̂(1−p̂)/n + z²/(4n²) )] / (1 + z²/n)
      p̂ = 0, n = 100, z = 1.96
        → 中心项 z²/(2n) = 0.019 208 0
        → 半宽   z·√(z²/(4n²)) = 1.96 × 0.009 800 = 0.019 208 0
        → 上界   (0.019 208 + 0.019 208)/1.038 416 = 0.036 995 ≈ 3.70%   ← 与论文一致
      交叉核对：Clopper-Pearson 0/100 = 3.62%；rule of three = 3.00%
      另：0/50 的正确 Wilson 上界为 7.14%（非 3.6%）

结论：论文原文"（0/100）… 上界为 3.7%"【本来就是正确的】，本次予以恢复。
"""
import zipfile, os, shutil
from lxml import etree

DOCX = r"D:/驭弓大师/03_论文打磨版_驭弓大师.docx"
BAK  = r"D:/驭弓大师/13_专家评审意见/03_论文打磨版_第9轮修改前备份.docx"
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

shutil.copy2(DOCX, BAK)
print("备份 ->", BAK)

with zipfile.ZipFile(DOCX) as z:
    names = z.namelist()
    data = {n: z.read(n) for n in names}

root = etree.fromstring(data['word/document.xml'])

OLD = "例如“零缺口”（0/50）的点估计为 0，但 95% 置信区间上界为 3.6%"
NEW = "例如“零缺口”（0/100）的点估计为 0，但 95% 置信区间上界为 3.7%"

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
    os.remove(DOCX)
    os.replace(tmp, DOCX)
    print("已写回:", DOCX, os.path.getsize(DOCX), "bytes")
else:
    print("未命中（可能已是正确文本）")
