# -*- coding: utf-8 -*-
"""引擎灵敏度自测：注入已知重复句，验证引擎能检出（防假阴性）"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # 已改写：原 D:/驭弓大师/12_查重自检
from plagiarism_check import NGramIndex, jaccard, containment, clean_for_match

# 测试1：连续13字完全相同
idx = NGramIndex(13)
idx.add("受电弓是城轨车辆从接触网获取电能的关键部件。", "test", "src1")
h = idx.query("受电弓是城轨车辆从接触网获取电能的关键部件，这一点很重要。")
print("T1 完全相同句命中:", len(h) > 0, "命中gram数:", len(h))

# 测试2：改写（同义替换）——连续串被破坏，应不命中13字，但相似度应较高
h2 = idx.query("受电弓是城市轨道车辆从接触网取电的关键元件。")
print("T2 同义改写 13字命中:", len(h2) > 0, "（预期 False，靠引擎2捕获）")
print("   T2 相似度:", round(max(jaccard("受电弓是城市轨道车辆从接触网取电的关键元件。","受电弓是城轨车辆从接触网获取电能的关键部件。"),
                             containment("受电弓是城市轨道车辆从接触网取电的关键元件。","受电弓是城轨车辆从接触网获取电能的关键部件。")),3))

# 测试3：语序调整
a = "本文提出了一种基于指数加权移动平均的缓变趋势检测方法。"
b = "基于指数加权移动平均的缓变趋势检测方法是本文提出的一种新方法。"
print("T3 语序调整 相似度:", round(jaccard(a,b),3), "包含度:", round(containment(a,b),3))

# 测试4：完全无关句
print("T4 无关句 相似度:", round(jaccard("今天天气很好适合出去散步。","工单状态机包含六个状态。"),3))

# 测试5：13字规则边界——12字重合应不命中，13字应命中
long_a = "碳滑板的磨耗状态直接影响弓网受流质量与安全"
idx2 = NGramIndex(13)
idx2.add(long_a, "t", "s")
print("T5 12字重合:", len(idx2.query(long_a[:12]+"。"))>0, "(预期 False)")
print("T5 13字重合:", len(idx2.query(long_a[:13]+"。"))>0, "(预期 True)")
print("T5 14字重合:", len(idx2.query(long_a[:14]+"。"))>0, "(预期 True)")
