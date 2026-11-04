#requires -Version 5.0
<#
  plc-sim-doctor.ps1 —— PLC 模拟器启动诊断（Windows PowerShell 5.1 兼容）
  用法:
    powershell -ExecutionPolicy Bypass -File tools\plc-sim-doctor.ps1
    powershell -ExecutionPolicy Bypass -File tools\plc-sim-doctor.ps1 -Port 1503
    powershell -ExecutionPolicy Bypass -File tools\plc-sim-doctor.ps1 -Fix
  安全说明:
    -Fix 仅终止“占用目标端口的 plc-simulator 进程”，不会按命令行全量匹配，
    避免误杀其它 Node 进程（例如承载当前命令的进程）。
#>
param(
  [int]$Port = 1502,
  [switch]$Fix,
  [switch]$UseSimulator
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not (Test-Path (Join-Path $root 'plc-simulator.js'))) { $root = (Get-Location).Path }
$script:ok = 0; $script:bad = 0

function Say($mark, $msg, $hint) {
  if ($mark -eq 'OK') { $script:ok++; $color = 'Green' }
  elseif ($mark -eq 'XX') { $script:bad++; $color = 'Red' }
  else { $color = 'Yellow' }
  Write-Host ("  [{0}] {1}" -f $mark, $msg) -ForegroundColor $color
  if ($hint) { Write-Host ("       -> {0}" -f $hint) -ForegroundColor DarkGray }
}

function Get-CmdLine($procId) {
  try { return (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $procId) -ErrorAction SilentlyContinue).CommandLine } catch { return '' }
}
function Test-IsSimulator($cmdLine) {
  if (-not $cmdLine) { return $false }
  if ($cmdLine -notlike '*plc-simulator.js*') { return $false }
  if ($cmdLine -like '*runner.js*') { return $false }      # 排除承载命令的进程
  if ($cmdLine -like '*dsh-*') { return $false }
  if ($cmdLine -like '*powershell*') { return $false }
  return $true
}

Write-Host "==== PLC 模拟器启动诊断 ====" -ForegroundColor Cyan
Write-Host ("工程目录: {0}" -f $root)
Write-Host ""

Write-Host "[1/6] Node.js 环境"
$nv = $null
try { $nv = (& node -v) 2>$null } catch {}
if ($nv) { Say 'OK' ("Node.js {0}" -f $nv) $null }
else { Say 'XX' '未检测到 node' '安装 Node.js（建议 20.19+ 或 22.12+）并加入 PATH' }

Write-Host "[2/6] 依赖与关键模块"
$nm = Join-Path $root 'node_modules'
if (Test-Path $nm) { Say 'OK' 'node_modules 存在' $null } else { Say 'XX' 'node_modules 缺失' '在工程目录执行 npm install' }
if (Test-Path (Join-Path $nm 'modbus-serial')) { Say 'OK' 'modbus-serial 已安装' $null }
else { Say 'XX' 'modbus-serial 未安装' 'npm install（PLC 模拟器依赖该模块）' }

Write-Host "[3/6] 配置文件 .env"
$envf = Join-Path $root '.env'
$lines = @()
if (Test-Path $envf) {
  Say 'OK' '.env 存在' $null
  $lines = Get-Content $envf -Encoding UTF8
  foreach ($k in @('PLC_MODE','PLC_HOST','PLC_PORT','PLC_UNIT_ID','PLC_SIM_PORT','PLC_SIM_INTERVAL')) {
    $line = ($lines | Where-Object { $_ -match ("^\s*" + $k + "\s*=") } | Select-Object -First 1)
    if ($line) { Write-Host ("       {0}" -f $line.Trim()) -ForegroundColor DarkGray }
  }
  $plcPortLine = ($lines | Where-Object { $_ -match '^\s*PLC_PORT\s*=' } | Select-Object -First 1)
  if ($plcPortLine) {
    $plcPortVal = ($plcPortLine -replace '^\s*PLC_PORT\s*=\s*', '').Trim()
    if ($plcPortVal -ne [string]$Port) {
      Say '!!' ("平台 .env 的 PLC_PORT={0} 与模拟器端口 {1} 不一致" -f $plcPortVal, $Port) `
        ("二者必须一致：运行本脚本加 -UseSimulator 自动改为 {0}（会备份 .env），或用 --port {1} 启动模拟器" -f $Port, $plcPortVal)
    }
  }
} else { Say 'XX' '.env 不存在' '复制 .env.example 为 .env 后修改' }

Write-Host ("[4/6] 端口占用（{0}）" -f $Port)
$conns = @()
try { $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) } catch {}
$simPids = @()
if ($conns.Count -gt 0) {
  foreach ($c in $conns) {
    $pname = ''; $cl = ''
    try { $pname = (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName } catch {}
    $cl = Get-CmdLine $c.OwningProcess
    if (Test-IsSimulator $cl) { $simPids += $c.OwningProcess }
    $suffix = ''
    if ($simPids -contains $c.OwningProcess) { $suffix = ' —— 是残留的模拟器进程' }
    Say 'XX' ("端口 {0} 被 PID {1}（{2}）占用{3}" -f $Port, $c.OwningProcess, $pname, $suffix) `
      ("清理残留：加 -Fix 重新运行；若为其他程序：node plc-simulator.js --port {0} 并同步改 .env" -f ($Port + 1))
  }
} else { Say 'OK' ("端口 {0} 空闲" -f $Port) $null }

Write-Host "[5/6] 残留模拟器进程"
if ($simPids.Count -gt 0) {
  if ($Fix) {
    foreach ($pid_ in $simPids) {
      Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue
      Write-Host ("       -> 已终止占用端口 {0} 的模拟器 PID {1}" -f $Port, $pid_) -ForegroundColor Yellow
    }
    Start-Sleep -Seconds 1
    Say 'OK' '残留模拟器进程已清理' $null
  } else {
    foreach ($pid_ in $simPids) { Say '!!' ("PID {0} 正在运行模拟器并占用端口 {1}" -f $pid_, $Port) $null }
    Say '!!' '清理方式：重新运行本脚本并加 -Fix' $null
  }
} else { Say 'OK' ("未发现占用端口 {0} 的模拟器进程" -f $Port) $null }

Write-Host "[6/6] 平台侧连接配置核对"
$modeLine = ($lines | Where-Object { $_ -match '^\s*PLC_MODE\s*=' } | Select-Object -First 1)
$hostLine = ($lines | Where-Object { $_ -match '^\s*PLC_HOST\s*=' } | Select-Object -First 1)
if ($modeLine -and ($modeLine -match 'simulation')) {
  Say '!!' 'PLC_MODE=simulation：平台不会连接模拟器' '如需联调：运行本脚本加 -UseSimulator（自动改为 real + 127.0.0.1 + 端口对齐，并备份 .env）'
} elseif ($hostLine -and ($hostLine -notmatch '127\.0\.0\.1') -and ($hostLine -notmatch 'localhost')) {
  Say '!!' ("PLC_HOST 不是本机：{0}" -f ($hostLine -replace '^\s*PLC_HOST\s*=\s*','').Trim()) '联调时用 -UseSimulator 自动设为 127.0.0.1'
} else { Say 'OK' '平台连接配置可用于本机模拟器' $null }


# ---------- 可选：一键切换为“模拟器联调”配置（备份 .env） ----------
if ($UseSimulator -and (Test-Path $envf)) {
  $bak = Join-Path $root (".env.bak." + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Copy-Item -Force $envf $bak
  $arr = @(Get-Content $envf -Encoding UTF8)
  function Set-EnvKey([string[]]$lines, [string]$key, [string]$value) {
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match ("^\s*" + $key + "\s*=")) { $lines[$i] = ($key + "=" + $value); $found = $true }
    }
    if (-not $found) { $lines += ($key + "=" + $value) }
    return ,$lines
  }
  $arr = Set-EnvKey $arr 'PLC_MODE' 'real'
  $arr = Set-EnvKey $arr 'PLC_HOST' '127.0.0.1'
  $arr = Set-EnvKey $arr 'PLC_PORT' ([string]$Port)
  $arr = Set-EnvKey $arr 'PLC_UNIT_ID' '1'
  [System.IO.File]::WriteAllLines($envf, $arr, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ""
  Write-Host "[配置已更新] 模拟器联调模式" -ForegroundColor Green
  Write-Host ("  备份文件: {0}" -f $bak) -ForegroundColor DarkGray
  Write-Host "  已设置: PLC_MODE=real  PLC_HOST=127.0.0.1  PLC_PORT=$Port  PLC_UNIT_ID=1" -ForegroundColor DarkGray
  Write-Host "  下一步: 选择 1 启动模拟器，然后重启平台（npm start）" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host ("==== 结论：通过 {0} 项，问题 {1} 项 ====" -f $script:ok, $script:bad) -ForegroundColor Cyan
if ($script:bad -eq 0) {
  Write-Host "可以启动：npm run plc-sim   或双击 启动PLC模拟器.bat 选择 1" -ForegroundColor Green
} else {
  Write-Host "请按上面的 -> 提示处理后重试。" -ForegroundColor Yellow
}
