# -*- coding: utf-8 -*-
"""
把 menu 版启动器合并为 canonical 的「启动平台1.0.bat」。

背景：目录里原有两只启动器——
  · 启动平台.bat      —— 菜单版（启动 / 构建 / PLC模拟器 / 环境自检），功能更全，
                        但标题与错误提示里的路径仍指向旧工程
                        D:\\realtime-platform\\realtime-platform-main
  · 启动平台1.0.bat   —— 先前生成的简化版（只启动服务），功能较弱
两只并存容易误用，故合并为一只：保留菜单版能力，仅修正标题与路径。
"""
import io, os

DST = r'D:/realtime-platform1.0'
SRC = os.path.join(DST, '启动平台.bat')
OUT = os.path.join(DST, '启动平台1.0.bat')

with io.open(SRC, encoding='gbk', errors='replace') as f:
    s = f.read()

repl = [
    ('受电弓碳滑板监测平台 - 启动器', '受电弓碳滑板监测平台 1.0 - 启动器'),
    (r'echo        正确位置应为: D:\realtime-platform\realtime-platform-main\启动平台.bat',
     r'echo        正确位置应为: D:\realtime-platform1.0\启动平台1.0.bat'),
]

miss = []
for a, b in repl:
    if a in s:
        s = s.replace(a, b)
    else:
        miss.append(a[:70])

if miss:
    print('!! 未匹配到以下片段：')
    for m in miss:
        print('   ', m)
    raise SystemExit(1)

with io.open(OUT, 'w', encoding='gbk', newline='\r\n') as f:
    f.write(s)

print('已生成', OUT, '(%d bytes)' % os.path.getsize(OUT))
print('菜单版原文件 启动平台.bat 保留在磁盘，但将加入 .gitignore（不再发布）')
