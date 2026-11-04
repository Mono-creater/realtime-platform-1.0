@echo off
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

echo [3] 序号边界用例（论文表8）
node tools/verify_seq.js
echo.

echo [4] 缓变检出时延（论文表10）
node tools/verify_latency.js
echo.

echo [5] 告警引擎处理效果（论文 §4.4 / P115 / P117）
node tools/verify_alarm.js
echo.

echo [6] 运维闭环（论文表5/表15、式9）
node tools/verify_maint.js
echo.

echo [7] RUL 无偏性（论文 §4.5）
node tools/verify_rul.js
echo.

echo ============================================================
echo   验证完成。详细口径对照见：论文-平台技术对照与升级说明.md
echo ============================================================
pause
