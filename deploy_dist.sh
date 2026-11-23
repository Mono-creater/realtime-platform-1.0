#!/usr/bin/env bash
# 部署新版 dist 到 106.53.216.144:3000
# 用法：把 dist_new_20261123.tar.gz 传到 /root 后，执行 bash deploy_dist.sh
set -uo pipefail

NEW_TGZ="${1:-/root/dist_new_20261123.tar.gz}"

if [ ! -f "$NEW_TGZ" ]; then
  echo "ERROR: 找不到部署包 $NEW_TGZ"
  exit 1
fi

# 1. 通过 3000 端口定位应用进程与工作目录
PID=$(ss -tlnp 2>/dev/null | grep ':3000 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
if [ -z "${PID:-}" ]; then
  echo "ERROR: 没有进程监听 3000 端口"
  exit 1
fi
APP=$(readlink -f "/proc/$PID/cwd")
CMDLINE=$(tr '\0' ' ' < "/proc/$PID/cmdline")
echo "PID=$PID"
echo "应用目录=$APP"
echo "启动命令=$CMDLINE"

if [ ! -d "$APP/dist" ]; then
  echo "ERROR: $APP/dist 不存在，请确认应用目录"
  exit 1
fi

# 2. 备份现役 dist
TS=$(date +%Y%m%d_%H%M%S)
BK="$APP/dist_backup_$TS.tar.gz"
tar -czf "$BK" -C "$APP" dist && echo "已备份: $BK ($(du -h "$BK" | cut -f1))"

# 3. 覆盖新 dist
tar -xzf "$NEW_TGZ" -C "$APP/dist" || { echo "ERROR: 解压失败"; exit 1; }
echo "已解压新 dist 到 $APP/dist"

# 4. 重启服务
UNIT=$(systemctl list-units --type=service --no-pager 2>/dev/null \
  | awk '{print $1}' | grep '\.service$' \
  | while read -r u; do
      mp=$(systemctl show -p MainPID --value "$u" 2>/dev/null)
      [ "$mp" = "$PID" ] && echo "$u" && break
    done | head -1)

if [ -n "${UNIT:-}" ]; then
  systemctl restart "$UNIT" && echo "已重启 systemd 服务: $UNIT"
elif command -v pm2 >/dev/null 2>&1 && pm2 pid all 2>/dev/null | grep -qw "$PID"; then
  pm2 restart all && echo "已 pm2 restart all"
else
  echo "未识别服务管理器，改为 kill + 原命令拉起"
  kill "$PID" 2>/dev/null
  sleep 2
  cd "$APP" || exit 1
  nohup bash -c "$CMDLINE" > "$APP/nohup.restart.log" 2>&1 &
  echo "已重启，日志: $APP/nohup.restart.log"
fi

# 5. 验证
sleep 3
FP=$(curl -s --max-time 8 http://127.0.0.1:3000/ | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1)
echo "线上资源指纹: ${FP:-（未取到，请检查服务是否已起来）}"
if [ "$FP" = "index-CnjZDIGg.js" ]; then
  echo "OK: 新版已生效"
else
  echo "WARN: 指纹不是预期的 index-CnjZDIGg.js"
fi
