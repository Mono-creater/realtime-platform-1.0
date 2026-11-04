@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title PLC 模拟器启动器

echo ============================================================
echo   受电弓碳滑板监测平台 - PLC 模拟器启动器
echo   工程目录: %CD%
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请安装 Node.js 20.19+ / 22.12+ 并加入 PATH。
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODEV=%%v
echo [信息] Node.js %NODEV%

if not exist "node_modules" (
  echo [错误] 未找到 node_modules，请先在本目录执行: npm install
  echo.
  pause
  exit /b 1
)
if not exist "node_modules\modbus-serial" (
  echo [错误] 缺少 modbus-serial 模块，请执行: npm install
  echo.
  pause
  exit /b 1
)

echo.
echo 请选择操作:
echo   1  正常启动（端口 1502）
echo   2  清理残留模拟器进程后启动
echo   3  换端口启动（1503，需同步修改 .env 的 PLC_PORT）
echo   4  运行诊断（环境 / 端口 / 配置）
echo   5  注入高温异常启动（验证告警链路）
echo   6  一键切换为模拟器联调配置（自动改 .env 并备份）
echo.
choice /c 123456 /n /m "输入序号并回车 [1-6]: "
set CH=%errorlevel%

if "%CH%"=="4" (
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "tools\plc-sim-doctor.ps1"
  echo.
  pause
  exit /b 0
)

if "%CH%"=="2" (
  echo [信息] 清理占用 1502 端口的残留模拟器进程...
  powershell -NoProfile -ExecutionPolicy Bypass -File "tools\plc-sim-doctor.ps1" -Fix
  echo.
  timeout /t 2 >nul
)

if "%CH%"=="3" (
  echo [信息] 以端口 1503 启动，请把平台 .env 的 PLC_PORT 改为 1503
  echo.
  node plc-simulator.js --port 1503
  echo.
  pause
  exit /b 0
)

if "%CH%"=="5" (
  echo [信息] 注入高温异常启动（temperature:high）
  echo.
  node plc-simulator.js --anomaly temperature:high
  echo.
  pause
  exit /b 0
)

if "%CH%"=="6" (
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "tools\plc-sim-doctor.ps1" -UseSimulator
  echo.
  pause
  exit /b 0
)

echo [信息] 启动模拟器（Ctrl+C 退出）...
echo.
node plc-simulator.js
echo.
echo [提示] 模拟器已退出。若提示端口被占用，请重开本启动器并选择 2 清理残留进程。
pause
