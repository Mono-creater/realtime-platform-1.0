# -*- coding: utf-8 -*-
"""投稿格式自检（2026-10-18，论文12.8，中文核心通用规范）：编号连续性 / 引用有效性 / 摘要数值对照 / 文献抽查 / 待补清单"""
import re, os
from docx import Document

DOCX = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', '论文12.8.docx')
doc = Document(DOCX)
paras = [p.text.strip() for p in doc.paragraphs]
full = '\n'.join(paras)

# ---------- 1) 一级标题与二级标题连续性 ----------
print('=== 1) 章节标题连续性 ===')
heads = [t for t in paras if re.match(r'^\d(\.\d+)*\s', t)]
print('  一级:', [t for t in heads if re.match(r'^\d\s', t)])
print('  二级:', [t for t in heads if re.match(r'^\d\.\d\s', t)])

# ---------- 2) 表/图/式 定义与引用 ----------
print('\n=== 2) 表/图/式编号 ===')
tab_defs = sorted({int(m.group(1)) for m in re.finditer(r'^表\s*(\d+)[　\s]', full, re.M)})
fig_defs = sorted({int(m.group(1)) for m in re.finditer(r'^图\s*(\d+)[　\s]', full, re.M)})
eq_defs = sorted({int(m.group(1)) for m in re.finditer(r'^[（(]\s*(\d+)\s*[)）]\s*$', full, re.M)})
print(f'  表定义: {tab_defs}')
print(f'  图定义: {fig_defs}')
print(f'  式定义: {eq_defs}')
tab_refs = sorted({int(m.group(1)) for m in re.finditer(r'[表見见](?:\s*)(\d+)', full)})
fig_refs = sorted({int(m.group(1)) for m in re.finditer(r'[图圖](?:\s*)(\d+)', full)})
eq_refs = sorted({int(m.group(1)) for m in re.finditer(r'式\s*[（(](\d+)[)）]', full)})
print(f'  表引用: {tab_refs}')
print(f'  图引用: {fig_refs}')
print(f'  式引用: {eq_refs}')
for name, d, r in [('表', tab_defs, tab_refs), ('图', fig_defs, fig_refs), ('式', eq_defs, eq_refs)]:
    missing_def = set(r) - set(d)
    unused = set(d) - set(r)
    print(f'  {name}: 引用未定义 {sorted(missing_def) if missing_def else "无"} | 定义未引用 {sorted(unused) if unused else "无"}')

# ---------- 3) 中英摘要数值对照 ----------
print('\n=== 3) 中英摘要数值对照 ===')
cn_abs = next((t for t in paras if t.startswith('摘要')), '')
en_abs = next((t for t in paras if t.startswith('Abstract')), '')
def nums(t):
    return re.findall(r'\d+(?:[.,]\d+)?', t)
cn_n, en_n = nums(cn_abs), nums(en_abs)
print(f'  中文摘要数值: {cn_n}')
print(f'  英文摘要数值: {en_n}')

# ---------- 4) 参考文献 ----------
print('\n=== 4) 参考文献条目 ===')
refs = []
in_refs = False
for t in paras:
    if t == '参考文献':
        in_refs = True
        continue
    if in_refs and re.match(r'^\[\d+\]', t):
        refs.append(t)
print(f'  条数: {len(refs)}')
nums = [int(re.match(r'^\[(\d+)\]', t).group(1)) for t in refs]
print(f'  编号: {nums[:5]}…{nums[-3:]} | 连续: {"是" if nums == list(range(1, len(nums)+1)) else "否"}')
print('  抽查条目：')
for t in refs[:3] + refs[9:13]:
    print(f'    {t[:110]}')

# ---------- 5) 待补清单 ----------
print('\n=== 5) 待补清单（用户决定留空项） ===')
head = paras[:10]
for label, key in [('作者', '作者'), ('基金', '基金'), ('邮箱', '邮箱'), ('中图分类号', '中图分类号'), ('文献标志码', '文献标志码'), ('收稿日期', '收稿')]:
    hit = [t for t in head if key in t]
    if not hit:
        print(f'  ❌ 缺: {label}（首页未出现）')
    else:
        body = hit[0].split('：', 1)[-1].strip()
        print(f'  ⚠️ 有占位但为空: {label}' if not body else f'  ✓ {label}: {body[:40]}')
# 首页是否含署名行（第二行为单位名，说明作者行空置）
print(f'  首页前 3 段: {[t[:20] for t in head[:3]]}')
