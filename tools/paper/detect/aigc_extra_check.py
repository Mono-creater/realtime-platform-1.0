# -*- coding: utf-8 -*-
"""AIGC 补充模块（2026-10-18，论文12.8）：模板词扫描 / 完全重复句 / 结论句式同构（m2）/ 句长变异"""
import re, os, statistics
from collections import Counter
from docx import Document

DOCX = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', '论文12.8.docx')
doc = Document(DOCX)

paras = []
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
        paras.append(t)
body = '\n'.join(paras)

# ---------- 1) 模板词 / 套话扫描 ----------
TPL = ['首先', '其次', '再次', '最后', '综上', '总之', '总而言之', '综上所述',
       '值得注意的是', '不难发现', '不难看出', '显而易见', '众所周知', '一方面', '另一方面',
       '随着科技的', '随着时代的', '众所周知', '值得一提的是', '总而言之']
print('=== 1) 模板词/套话扫描 ===')
total_hits = 0
for w in TPL:
    n = body.count(w)
    if n:
        total_hits += n
        for m in re.finditer(re.escape(w), body):
            s = max(0, m.start() - 18)
            print(f'  {w} ×{n}: …{body[s:m.end()+18]}…')
if total_hits == 0:
    print('  无命中。')
else:
    print(f'  合计命中 {total_hits} 次。')

# ---------- 2) 完全重复句 ----------
def split_sent(t):
    return [s.strip() for s in re.split(r'[。！？!?\n]', t) if s.strip()]

sents = []
for t in paras:
    sents.extend(split_sent(t))
norm = [re.sub(r'[^一-鿿A-Za-z0-9]', '', s) for s in sents]
cnt = Counter(norm)
dups = {k: v for k, v in cnt.items() if v > 1 and len(k) >= 10}
print('\n=== 2) 完全重复句（归一化后整句相同，≥10 字） ===')
if not dups:
    print('  无。')
else:
    for k, v in dups.items():
        print(f'  ×{v}: {k[:60]}')

# ---------- 3) 结论句式同构（m2 遗留问题复查） ----------
print('\n=== 3) 结束语句式结构 ===')
concl = []
grab = False
for t in paras:
    if t == '5 结束语':
        grab = True
        continue
    if grab:
        concl.append(t)
# 结束语抓到下一个一级标题前；这里按段落数近似（结束语含 5 段：导语+4条+局限）
concl_sents = []
for t in concl:
    concl_sents.extend(split_sent(t))
print(f'  句子数 {len(concl_sents)}；各句开头 16 字与句长：')
for s in concl_sents:
    sl = len(re.sub(r'[^一-鿿]', '', s))
    print(f'    〔{sl:3d} 字〕 {s[:16]}…')
# 同构检测：相同开头 4 字的句数
opens = Counter(s[:4] for s in concl_sents)
same = {k: v for k, v in opens.items() if v > 1}
print(f'  相同开头 4 字的句组: {same if same else "无"}')
# 并列条目模式（（n）开头）
items = [s for s in concl_sents if re.match(r'^（[1-9]）', s)]
print(f'  （n）编号条目 {len(items)} 条（结论分条属规范写法，不判同构）')

# ---------- 4) 句长变异（全正文） ----------
print('\n=== 4) 句长变异 ===')
lens = [len(re.sub(r'[^一-鿿]', '', s)) for s in sents]
lens = [l for l in lens if l >= 8]
print(f'  句数 {len(lens)} | 均值 {statistics.mean(lens):.1f} 字 | 标准差 {statistics.pstdev(lens):.1f} | 变异系数 {statistics.pstdev(lens)/statistics.mean(lens):.2f}')

# ---------- 5) 破折号密度（m12 遗留问题复查） ----------
print('\n=== 5) 破折号（——）密度 ===')
n_dash = body.count('——')
cn = len(re.sub(r'[^一-鿿]', '', body))
print(f'  {n_dash} 次，每千汉字 {n_dash/cn*1000:.1f} 次')
