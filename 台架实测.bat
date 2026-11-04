@echo off
chcp 65001 >nul
cd /d "%~dp0"

if "%~1"=="" goto help

node bench\run.js %*
goto end

:help
echo.
echo   Bench runner  (realtime-platform2.0)
echo.
echo   bench.bat status                      one-screen status
echo   bench.bat plan                        today's sequence
echo   bench.bat env --apply                 switch .env to bench profile
echo   bench.bat preflight                   readiness check (must be all PASS)
echo   bench.bat sigma --label elec          sigma analysis
echo   bench.bat lift --profile g3 --cycles 30 --yes
echo   bench.bat scene --label G1 --duration 1020
echo   bench.bat export --label ALL
echo.
echo   Docs: bench\README-台架执行手册.md
echo.

:end
