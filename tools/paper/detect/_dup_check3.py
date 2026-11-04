# -*- coding: utf-8 -*-
"""查重预检 v3：修正表格标记污染，最终干净口径"""
import re, os
from docx import Document
from collections import defaultdict

# 已改写（2026-10-18）：原硬编码 D:/驭弓大师/论文11.1.docx → 论文12.8
DOCX = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', '论文12.8.docx')
doc = Document(DOCX)

paras = []          # (text, is_table)
in_refs = False
for p in doc.paragraphs:
    t = p.text.strip()
    if t == '参考文献':
        in_refs = True
    if in_refs:
        continue
    if re.match(r'^表\s*\d+|^图\s*\d+|^注：|^Fig\.|^Table', t):
        continue
    if t:
        paras.append((t, False))
for tb in doc.tables:
    for row in tb.rows:
        for c in row.cells:
            t = c.text.strip()
            if t:
                paras.append((t, True))

def classify(t, is_table):
    if 'Abstract:' in t or 'Keywords:' in t or re.match(r'^Abstract', t):
        return 'EN-Abs'
    if t.startswith('摘要'):
        return 'CN-Abs'
    if is_table:
        return 'Table'
    if t.startswith('5 结束语'):
        return 'Conclusion'
    return 'Body'

tags = [classify(t, ist) for t, ist in paras]

chunks = []
for (t, _), tag in zip(paras, tags):
    c = re.sub(r'[^\u4e00-\u9fffA-Za-z0-9]', '', t)
    chunks.append(c)
clean = ''.join(chunks)
pos2para = []
for i, c in enumerate(chunks):
    pos2para.extend([i] * len(c))

print('正文段落数:', len(paras), '| clean 字符数:', len(clean))

N = 13
freq = defaultdict(list)
for i in range(len(clean) - N + 1):
    freq[clean[i:i+N]].append(i)
dups = {g: pos for g, pos in freq.items() if len(pos) >= 2}
print('重复 13-gram 数:', len(dups))

covered = [False] * len(clean)
for g, pos in dups.items():
    for p in pos:
        for i in range(p, p + N):
            covered[i] = True
segments = []
i = 0
while i < len(clean):
    if covered[i]:
        j = i
        while j < len(clean) and covered[j]:
            j += 1
        segments.append((i, j))
        i = j
    else:
        i += 1
segments = [(a, b) for a, b in segments if b - a >= N]
print('合并后重复区段数（>=13字符）:', len(segments))

seg_info = []
for a, b in segments:
    seg_text = clean[a:b]
    occ = [m.start() for m in re.finditer(re.escape(seg_text), clean)]
    o_tags = sorted({tags[pos2para[o]] for o in occ})
    seg_info.append((b-a, tags[pos2para[a]], seg_text, o_tags, len(occ)))

seg_info.sort(reverse=True)

print()
print('=== 重复区段（按长度降序，Top 25）===')
for L, ta, txt, otags, n in seg_info[:25]:
    show = txt if len(txt) <= 55 else txt[:27] + '…' + txt[-22:]
    print(f'[{L:3d}字 x{n}] {ta} {"|".join(otags)}: {show}')

cat_chars = defaultdict(int)
cat_cnt = defaultdict(int)
for L, ta, txt, otags, n in seg_info:
    key = '|'.join(otags)
    cat_chars[key] += L
    cat_cnt[key] += 1
print()
print('=== 按涉及段落类别汇总 ===')
for k in sorted(cat_chars, key=lambda x: -cat_chars[x]):
    print(f'{k}: {cat_cnt[k]} 段, 共 {cat_chars[k]} 字符')

tot = sum(L for L, *_ in seg_info)
cov = sum(b-a for a, b in segments)
print()
print('重复区段总覆盖（去重）:', cov, f'| 占 clean 流 {cov/len(clean)*100:.1f}%')
print('总重复字符（各区段累加）:', tot)

# 段号映射（供报告引用）
print()
print('=== 关键区段的段落定位 ===')
for L, ta, txt, otags, n in seg_info[:12]:
    # 找该区段首位置所在段
    occ = [m.start() for m in re.finditer(re.escape(txt), clean)]
    ps = [pos2para[o] for o in occ]
    print(f'[{L}字 x{n}] 段{ps} → {txt[:45]}')
