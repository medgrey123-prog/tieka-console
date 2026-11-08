#!/bin/bash
# dsh-lark-bot 安装/管理脚本（macOS launchd）
# 随 tieka-console 套件分发；launchd label 用通用名，可用 DSH_LARK_BOT_LABEL 覆盖
# （旧安装若用过别的 label，先停掉旧 plist 再 install）。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="${DSH_LARK_BOT_LABEL:-com.tieka.dsh-lark-bot}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$HOME/.dsh-lark-bot"
NODE="$(command -v node || echo /usr/local/bin/node)"
DOMAIN="gui/$(id -u)"

c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
c_dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

# plist 是 XML：路径里可能有 & < >（例如目录名带空格没问题，带 & 会坏），统一转义。
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"
  local label_x node_x dir_x bot_x home_x root_x
  label_x="$(xml_escape "$LABEL")"
  node_x="$(xml_escape "$NODE")"
  dir_x="$(xml_escape "$DIR")"
  bot_x="$(xml_escape "$DIR/bot.mjs")"
  home_x="$(xml_escape "$HOME")"
  root_x="$(xml_escape "$ROOT")"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label_x</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_x</string>
    <string>$bot_x</string>
  </array>
  <key>WorkingDirectory</key><string>$dir_x</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$home_x</string>
    <key>PATH</key><string>$home_x/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$root_x/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$root_x/logs/launchd.err.log</string>
</dict>
</plist>
PLISTEOF
}

bootout() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  # 兼容旧接口
  launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  sleep 1
}

bootstrap() {
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
  launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
}

status() {
  echo "── launchd ──"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state = |pid = |last exit code|runs = " | sed 's/^[[:space:]]*/  /'
  else
    c_red "  未加载（未安装或已停止）"
  fi
  echo "── bot ──"
  (cd "$DIR" && node bot.mjs --status 2>/dev/null) || c_red "  bot.mjs 状态读取失败"
  echo "── 最近日志 ──"
  latest=$(ls -t "$ROOT"/logs/bot-*.log 2>/dev/null | head -1)
  [ -n "${latest:-}" ] && tail -8 "$latest" | sed 's/^/  /' || c_dim "  暂无日志"
}

case "${1:-status}" in
  install)
    echo "安装 $LABEL …"
    write_plist
    bootout
    bootstrap
    sleep 2
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      c_green "✅ 已安装并启动"
      echo "   plist: $PLIST"
      echo "   日志:  $ROOT/logs/"
      sleep 2
      status
    else
      c_red "❌ 启动失败，请查看 $ROOT/logs/launchd.err.log"
      tail -20 "$ROOT/logs/launchd.err.log" 2>/dev/null
      exit 1
    fi
    ;;
  uninstall)
    echo "卸载 $LABEL …"
    bootout
    rm -f "$PLIST" "$ROOT/bot.pid"
    c_green "✅ 已卸载（配置与日志保留在 ${ROOT}）"
    ;;
  restart)
    echo "重启 …"
    bootout
    write_plist
    bootstrap
    sleep 2
    c_green "✅ 已重启"
    status
    ;;
  stop)
    bootout
    c_green "✅ 已停止"
    ;;
  start)
    [ -f "$PLIST" ] || write_plist
    bootstrap
    sleep 2
    c_green "✅ 已启动"
    status
    ;;
  status)
    status
    ;;
  logs)
    exec tail -n "${2:-60}" -f "$ROOT"/logs/$(ls -t "$ROOT"/logs 2>/dev/null | grep -m1 '^bot-')
    ;;
  doctor)
    cd "$DIR" && node bot.mjs --doctor
    ;;
  test)
    echo "端到端自测（会真的在你的 Lark 里发消息）…"
    cd "$DIR" && node bot.mjs --simulate "${2:-回复：机器人链路自测正常}"
    ;;
  *)
    echo "用法: $0 {install|uninstall|restart|start|stop|status|logs|doctor|test [文本]}"
    exit 1
    ;;
esac
