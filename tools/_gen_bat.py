# -*- coding: utf-8 -*-
"""生成 1.0 启动脚本（GBK 编码，避免 Windows 控制台中文乱码）"""
import os

BASE = r"D:/realtime-platform1.0"

LAUNCH = r"""@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 受电弓碳滑板监测平台 1.0

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请安装 Node.js 20.19+ / 22.12+ 并加入 PATH。
  echo        下载地址: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo [错误] 当前目录下没有 package.json。
  echo        正确位置应为: D:\realtime-platform1.0\启动平台1.0.bat
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [提示] 未找到 node_modules，正在安装依赖（首次运行需要联网）...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络或 npm 配置。
    pause
    exit /b 1
  )
)

node server.js

echo.
echo [信息] 平台已退出。
pause
"""

VERIFY = r"""@echo off
chcp 936 >nul
cd /d "%~dp0"
title 论文数值复现验证 - 平台 1.0

echo ============================================================
echo   论文《城轨受电弓碳滑板监测平台的双包上报协议与告警运维闭环》
echo   平台 1.0 数值复现验证
echo ============================================================
echo.

echo [1] 单元测试（含论文口径断言）
node tests/run-tests.js
echo.

echo [2] REST 接口冒烟测试
node tests/smoke_routes.js
echo.

echo [3] 序号边界用例（论文表7）
node tools/verify_seq.js
echo.

echo [4] 缓变检出时延（论文表9）
node tools/verify_latency.js
echo.

echo [5] 告警引擎处理效果（论文表8）
node tools/verify_alarm.js
echo.

echo [6] 运维闭环（论文表5/表12、式8）
node tools/verify_maint.js
echo.

echo [7] RUL 无偏性（论文 §4.5）
node tools/verify_rul.js
echo.

echo ============================================================
echo   验证完成。详细口径对照见：论文-平台技术对照与升级说明.md
echo ============================================================
pause
"""

for name, content in [("启动平台1.0.bat", LAUNCH), ("论文数值复现验证.bat", VERIFY)]:
    p = os.path.join(BASE, name)
    with open(p, "w", encoding="gbk", newline="\r\n") as f:
        f.write(content)
    print(f"已写入 {p}  ({os.path.getsize(p)} bytes)")
