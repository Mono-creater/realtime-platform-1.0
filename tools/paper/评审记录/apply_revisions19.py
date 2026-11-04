# -*- coding: utf-8 -*-
"""
第6轮修改（R6-2）：表11 数值按定稿口径重算
- 解耦前：σ=2.0 ℃、缓冲按 60 点定长 → W_eff = 60×Δt；σ_ROC = √(2λ/(2−λ))·σeff/W_eff
- 解耦后：σ=1.0 ℃、窗口恒为 W=60 s → σ_ROC 恒为常数 0.316
- 说明文字同步为真正口径（原文“按式(8)”应改为“按式(6)”）
"""
import zipfile, os, shutil, math
from lxml import etree

SRC = r'D:/驭弓大师/03_论文打磨版_驭弓大师.docx'
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}

shutil.copy2(SRC, SRC.replace('.docx', '_第6轮修改前备份2.docx'))

# ---- 重算 ----
SEFF = math.sqrt(0.4487)
LAM = 0.2
def sigma_r(sigma, Wmin):
    seff = SEFF * sigma
    sZ = math.sqrt(seff**2 * LAM / (2 - LAM))
    return math.sqrt(2) * sZ / Wmin

rows = []
for dt_ms in [1000, 500, 200, 100]:
    dt_s = dt_ms / 1000.0
    W_eff_before = 60 * dt_s / 60.0          # min, 60 点固定缓冲
    sr_before = sigma_r(2.0, W_eff_before)
    sr_after = sigma_r(1.0, 1.0)             # W=60s 恒定
    rows.append((dt_ms, W_eff_before * 60, sr_before, sr_after))

print('重算表11：')
for dt_ms, weff_s, sb, sa in rows:
    print('  Δt=%4d ms | 解耦前 %.3f (%s s) | 解耦后 %.3f' % (dt_ms, sb, weff_s, sa))

zin = zipfile.ZipFile(SRC, 'r')
parts = {n: zin.read(n) for n in zin.namelist()}
zin.close()
doc = etree.fromstring(parts['word/document.xml'])
body = doc.find('w:body', NS)
tbls = body.findall('w:tbl', NS)

# 表11 = 第 11 个表（索引 10）
tb = tbls[10]
trs = tb.findall('w:tr', NS)
assert len(trs) == 5, '表11 行数异常: %d' % len(trs)

def set_cell(tc, txt):
    ts = tc.findall('.//w:t', NS)
    if not ts:
        return
    ts[0].text = txt
    ts[0].set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    for t in ts[1:]:
        t.text = ''

# 表11 列：Δt | 解耦前 σ_ROC | 解耦前等效窗口 | 解耦后 σ_ROC | 解耦后等效窗口
for r, (dt_ms, weff_s, sb, sa) in enumerate(rows, start=1):
    tcs = trs[r].findall('w:tc', NS)
    set_cell(tcs[1], '%.3f' % sb)
    set_cell(tcs[2], '%.1f' % weff_s)
    set_cell(tcs[3], '%.3f' % sa)
    set_cell(tcs[4], '%.1f' % 60.0)

# ---- 同步说明文字 ----
paras = doc.findall('.//w:body/w:p', NS)
def ptext(p):
    return ''.join(n.text or '' for n in p.findall('.//w:t', NS))
def set_para_text(p, s):
    ts = p.findall('.//w:t', NS)
    if not ts:
        return False
    ts[0].text = s
    ts[0].set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    for t in ts[1:]:
        t.text = ''
    return True

log = []
new_desc = ('EWMA 统计窗口与轮询周期的解耦效果如表11 所示。表中 σROC 一列按式（6）计算：'
            '解耦前取 σ = 2.0 ℃（对应未做滤波一致性处理、噪声等效放大的原判据口径），'
            '解耦后取 σ = 1.0 ℃（本文方法口径），两列口径不同，仅用于对比窗口随周期的漂移趋势。'
            '解耦前，等效窗口随轮询周期由 1 000 ms 缩短至 100 ms 而由 60.0 s 收缩至 6.0 s，'
            'σROC 随之由 %.3f 增至 %.3f ℃·min⁻¹，判据灵敏度随配置漂移；'
            '解耦后窗口在 Δt 跨越 10 倍范围内恒为 60.0 s，σROC 稳定在 %.3f ℃·min⁻¹，'
            '与设计的 60 s 窗口及式（6）理论值一致。' % (rows[0][2], rows[-1][2], rows[0][3]))
for p in paras:
    t = ptext(p)
    if 'EWMA 统计窗口与轮询周期的解耦效果如表11 所示' in t:
        set_para_text(p, new_desc)
        log.append('R6-2 说明文字：口径改为按式(6)、同步重算值')
        break

parts['word/document.xml'] = etree.tostring(doc, xml_declaration=True, encoding='UTF-8', standalone=True)
tmp = SRC + '.tmp'
with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zo:
    for n, d in parts.items():
        zo.writestr(n, d)
os.remove(SRC)
os.replace(tmp, SRC)

print('修改完成：')
for x in log:
    print(' -', x)
