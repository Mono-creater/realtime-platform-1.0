@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 受电弓碳滑板监测平台 1.2 - 启动器

echo ============================================================
echo   受电弓碳滑板监测平台 1.2 - 启动器
echo   工程目录: %CD%
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请安装 Node.js 20.19+ / 22.12+ 并加入 PATH。
  echo        下载地址: https://nodejs.org/
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODEV=%%v
echo [信息] Node.js %NODEV%

if not exist "package.json" (
  echo [错误] 当前目录下没有 package.json，说明本脚本不在工程目录内。
  echo        请把启动器放到平台根目录（与 package.json 同级）后再运行。
  echo.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo [错误] 未找到 node_modules，请先在本目录执行: npm install
  echo.
  pause
  exit /b 1
)
if not exist ".env" (
  echo [警告] 未找到 .env，平台将使用默认配置（PLC_HOST=192.168.1.88）。
  echo        联调前请执行: copy .env.example .env
  echo.
)

rem ---- 读取认证开关（仅用于启动提示，不修改 .env）----
set "AUTHON="
if exist ".env" (
  findstr /b /i /c:"AUTH_ENABLED=true" .env >nul 2>nul
  if not errorlevel 1 set "AUTHON=1"
)

set /a EMPTYN=0
:menu
echo.
echo ------------------------------------------------------------
echo   1. 启动平台（单端口 3000，使用已构建的 dist，推荐）
echo   2. 构建前端后启动（npm run build ^&^& npm start）
echo   3. 同时启动 PLC 模拟器与平台（两窗口，自动打开浏览器）
echo   4. 只启动 PLC 模拟器（联调用）
echo   5. 环境自检（Node / .env / 端口 / 运行态）
echo   6. 运行全部测试（204 项，约 2 分钟）
echo   7. 浏览器打开平台页面
echo   0. 退出
echo ------------------------------------------------------------
set "CHOICE="
set /p CHOICE=请输入序号并回车:
if not defined CHOICE (
  set /a EMPTYN+=1
  if !EMPTYN! GEQ 3 (
    echo [提示] 未检测到输入，脚本退出。
    exit /b 0
  )
  goto menu
)
set /a EMPTYN=0
echo.

if "%CHOICE%"=="1" goto run
if "%CHOICE%"=="2" goto buildrun
if "%CHOICE%"=="3" goto both
if "%CHOICE%"=="4" goto sim
if "%CHOICE%"=="5" goto check
if "%CHOICE%"=="6" goto testall
if "%CHOICE%"=="7" goto openpage
if "%CHOICE%"=="0" exit /b 0
echo [提示] 输入无效，请重新选择。
goto menu

:prestart
if not exist "dist\index.html" (
  echo [警告] 未找到 dist\index.html，页面打不开，请先选择 2 构建前端。
  echo.
)
if defined AUTHON (
  echo [提示] 已启用认证：浏览器会跳转登录页，账号见 .env 的 AUTH_OPERATOR_USER。
  echo        若未设置 AUTH_OPERATOR_PASS，首次启动会在下方打印随机密码，请留意。
  echo.
)
goto :eof

:run
call :prestart
call :openwhenready
echo [启动] 平台地址 http://127.0.0.1:3000 ，按 Ctrl+C 可停止。
echo.
call npm start
goto done

:buildrun
echo [构建] 正在执行 npm run build ...
call npm run build
if errorlevel 1 (
  echo.
  echo [错误] 构建失败，请查看上方输出。
  pause
  goto menu
)
echo.
call :prestart
call :openwhenready
echo [启动] 平台地址 http://127.0.0.1:3000 ，按 Ctrl+C 可停止。
echo.
call npm start
goto done

:both
echo [启动] 新窗口运行 PLC 模拟器，本窗口运行平台。
start "PLC 模拟器" cmd /k "node plc-simulator.js"
echo [等待] 正在等待模拟器监听 1502 端口 ...
set /a WAITN=0
:waitport
netstat -ano | findstr ":1502" | findstr LISTENING >nul 2>nul
if not errorlevel 1 goto portsready
set /a WAITN+=1
if %WAITN% GEQ 25 goto portsready
ping -n 2 127.0.0.1 >nul
goto waitport
:portsready
echo [就绪] 模拟器已监听（等待 %WAITN% 次探测）。
call :prestart
call :openwhenready
echo [启动] 平台地址 http://127.0.0.1:3000 ，按 Ctrl+C 可停止。
echo.
call npm start
goto done

:sim
echo [启动] PLC 模拟器（协议层模拟 Easy320），按 Ctrl+C 可停止。
echo.
call npm run plc-sim:closedloop
goto done

:check
echo ---- Node ----
where node
node -v
echo.
echo ---- .env 关键项 ----
if exist ".env" (
  findstr /b /c:"PLC_MODE" /c:"PLC_HOST" /c:"PLC_PORT" /c:"PLC_UNIT_ID" /c:"DATABASE_URL" /c:"AUTH_ENABLED" /c:"AUTH_OPERATOR_USER" /c:"ALLOW_SIM_FALLBACK" /c:"WS_SENSOR_MODE" .env
) else (
  echo [警告] 缺少 .env，请执行: copy .env.example .env
)
echo.
echo ---- 运行态与构建产物 ----
if exist "data\runtime-state.json" (echo [有] data\runtime-state.json) else (echo [无] 首次启动会自动创建)
if exist "dist\index.html" (echo [有] dist\index.html) else (echo [缺] 需执行 npm run build)
echo.
echo ---- 端口占用（无输出表示空闲）----
echo [3000]
netstat -ano | findstr ":3000" | findstr LISTENING
echo [1502]
netstat -ano | findstr ":1502" | findstr LISTENING
echo.
pause
goto menu

:openwhenready
echo [提示] 平台就绪后会自动打开浏览器（浏览器若已打开可忽略）。
start "" cmd /c "for /l %%i in (1,1,40) do (netstat -ano | findstr :3000 | findstr LISTENING >nul && (start http://127.0.0.1:3000 & exit) || ping -n 2 127.0.0.1 >nul)"
goto :eof

:testall
echo [测试] 全量回归：单元 / 存储 / 冒烟 / 集成 / 持久化 / 认证 / E2E
echo        E2E 需要本机 Chrome，未安装会自动跳过。
echo.
call npm run test:all
echo.
pause
goto menu

:openpage
start "" http://127.0.0.1:3000
echo [提示] 已在默认浏览器打开 http://127.0.0.1:3000
timeout /t 2 >nul
goto menu

:done
echo.
echo [信息] 进程已退出。按任意键返回菜单。
pause >nul
goto menu
