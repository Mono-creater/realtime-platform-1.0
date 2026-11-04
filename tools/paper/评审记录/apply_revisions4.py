# -*- coding: utf-8 -*-
"""第四批修改：表1后补定量对照段（建议7）"""
import os, zipfile
from lxml import etree
from copy import deepcopy

SRC = r"D:/驭弓大师/03_论文打磨版_驭弓大师.docx"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
def qn(t): return W + t

def read_parts(path):
    z = zipfile.ZipFile(path); d = {n: z.read(n) for n in z.namelist()}; z.close(); return d
def write_parts(parts, dst):
    tmp = dst + ".tmp"
    z = zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED)
    for n, data in parts.items(): z.writestr(n, data)
    z.close()
    if os.path.exists(dst): os.remove(dst)
    os.replace(tmp, dst)
def ptext(p): return "".join(t.text or "" for t in p.iter(qn("t")))

parts = read_parts(SRC)
root = etree.fromstring(parts["word/document.xml"])
body = root.find(".//" + qn("body"))
paras = body.findall(qn("p"))

# 定位表1标题段（"表1　传统、现有与本文方法的对比"）
target_idx = None
for i, p in enumerate(paras):
    if ptext(p).startswith("表1　传统、现有与本文方法的对比"):
        target_idx = i
        break

if target_idx is None:
    print("❌ 未找到表1标题")
else:
    # 用表1标题段作为模板，复制其格式新建一段
    tmpl = paras[target_idx]
    new_p = deepcopy(tmpl)
    # 清空所有 run 文字
    runs = new_p.findall(qn("r"))
    if runs:
        for r in runs[1:]:
            new_p.remove(r)
        first = runs[0]
        for child in list(first):
            if child.tag in (qn("t"), qn("br"), qn("tab")):
                first.remove(child)
        t = etree.SubElement(first, qn("t"))
        t.text = ("从量级上看，文献[12]面向受电弓缺陷的视觉识别在识别精度上已达 96% 以上，"
                  "但其数据通路依赖图像流，单路图像帧率与码率远高于本文的模拟量通道（本文单次事务仅 31 B）；"
                  "本文并不追求缺陷识别的精度指标，而是在 31 B/次的事务预算内解决模拟量的可追溯性与告警可信度，"
                  "两者在监测对象、数据量与评价指标上互补：文献[12]解决“看得准”，本文解决“传得省、判得稳、可追溯”。")
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    # 插入到表1标题之后
    tmpl.addnext(new_p)
    print("✅ 已在表1后插入定量对照段")

parts["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
write_parts(parts, SRC)
print("已写回")
