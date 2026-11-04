# -*- coding: utf-8 -*-
"""AIGC 痕迹增强统计 + 计费字符数估算"""
import re, os
import statistics
from collections import Counter
from docx import Document

# 已改写（2026-10-18）：原硬编码 D:/驭弓大师/论文11.1.docx → 论文12.8
DOCX = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', '论文12.8.docx')
doc = Document(DOCX)

# ---------- 计费字符数：全文所有可提取文本（含参考文献、图表） ----------
all_text = []
for p in doc.paragraphs:
    all_text.append(p.text)
for tb in doc.tables:
    for row in tb.rows:
        for c in row.cells:
            all_text.append(c.text)
full_all = '\n'.join(all_text)
# 计费一般按总字符（含空白）或纯字符，两者都算
chars_with_space = len(full_all)
chars_no_space = len(re.sub(r'\s', '', full_all))
chars_cn_like = len(re.sub(r'[^\u4e00-\u9fffA-Za-z0-9]', '', full_all))
print('=== 计费估算 ===')
print('全文字符数（含空白）:', chars_with_space)
print('全文字符数（不含空白）:', chars_no_space)
print('有效字符（汉字+字母+数字）:', chars_cn_like)
for label, n in [('含空白', chars_with_space), ('不含空白', chars_no_space)]:
    kj = -(-n // 1000)  # 向上取整到千字符
    print(f'按{label}估算：查重 {kj}×1.5={kj*1.5:.0f} 元 | AIGC {kj}×2={kj*2:.0f} 元 | 合计 {kj*3.5:.0f} 元')

# ---------- AIGC 增强指标（仅正文分析部分） ----------
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
text_cn = ''.join(re.sub(r'[^\u4e00-\u9fff]', '', p) for p in paras)

print()
print('=== AIGC 增强指标 ===')
# 1) type-token ratio（汉字单字丰富度）
uniq = len(set(text_cn))
print(f'汉字总数 {len(text_cn)} | 单字种类 {uniq} | TTR = {uniq/len(text_cn):.3f}（人类学术文本通常 0.30~0.55）')

# 2) 2-gram / 3-gram 重复率（出现>1次的比例；AI 文本偏高）
for n, name in [(2, '2-gram'), (3, '3-gram')]:
    grams = Counter(text_cn[i:i+n] for i in range(len(text_cn)-n+1))
    multi = sum(c for c in grams.values() if c > 1)
    total = sum(grams.values())
    print(f'{name}: 总 {total} | 重复出现占比 {multi/total*100:.1f}%')

# 3) 段落长度
plens = [len(re.sub(r'[^\u4e00-\u9fff]', '', p)) for p in paras]
plens = [l for l in plens if l > 0]
print(f'段落数 {len(plens)} | 段长均值 {statistics.mean(plens):.0f} 字 | 段长标准差 {statistics.pstdev(plens):.0f} | 变异系数 {statistics.pstdev(plens)/statistics.mean(plens):.2f}')

# 4) 标点密度（每千汉字）
for mark, name in [('，', '逗号'), ('；', '分号'), ('：', '冒号'), ('（', '括号'), ('—', '破折号'), ('、', '顿号')]:
    c = ''.join(p for p in paras).count(mark)
    print(f'{name}: {c} 次，即每千汉字 {c/len(text_cn)*1000:.1f} 次')

# 5) 最长无重复连续段：反映表达多样性
# 用 10-gram 检测完全无重复的最长跨度（粗算）
seen = set()
maxrun = 0
cur = 0
for i in range(len(text_cn)-10+1):
    g = text_cn[i:i+10]
    if g in seen:
        cur = 0
    else:
        seen.add(g)
        cur += 1
        maxrun = max(maxrun, cur)
print(f'无重复 10-gram 连续跨度最长: {maxrun+9} 字')
