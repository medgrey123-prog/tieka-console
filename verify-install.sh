#!/bin/bash
# verify-install.sh — 装完后逐项验收「铁卡老弟」中控台。
#
# 用法：
#   ./verify-install.sh                       # 基础检查（不含 DSH 页面路由）
#   ./verify-install.sh --dsh-url http://127.0.0.1:60118   # 额外检查观察台路由/汇报
#   ./verify-install.sh --review-profile tieka-review --task-profile tieka-task
#
# 退出码：0 = 全部通过；1 = 有 ❌；2 = 脚本自身参数错误。
# 说明：DSH 面板的「看得见」部分（侧栏图标/Agents tab）只能人眼确认，本脚本检查的是后台链路。

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_URL=""
REVIEW_PROFILE=""
TASK_PROFILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-url) DSH_URL="$2"; shift 2 ;;
    --review-profile) REVIEW_PROFILE="$2"; shift 2 ;;
    --task-profile) TASK_PROFILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0; WARN=0
ok()   { printf '  ✅ %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  ❌ %s\n' "$*"; FAIL=$((FAIL+1)); }
warn() { printf '  ⚠️  %s\n' "$*"; WARN=$((WARN+1)); }
section() { printf '\n== %s ==\n' "$*"; }

section "环境"
if command -v node >/dev/null 2>&1; then
  NODE_V=$(node --version | sed 's/v//;s/\..*//')
  [ "${NODE_V:-0}" -ge 24 ] && ok "Node $(node --version)" || bad "Node $(node --version)（需要 ≥ 24）"
else bad "找不到 node"; fi
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || bad "找不到 git"
command -v curl >/dev/null 2>&1 && ok "curl" || bad "找不到 curl"
command -v lark-cli >/dev/null 2>&1 && ok "lark-cli $(lark-cli --version 2>/dev/null | head -1)" || bad "找不到 lark-cli（npm i -g @larksuite/cli）"
command -v dsh >/dev/null 2>&1 && ok "dsh $(dsh --version 2>/dev/null | head -1)" || bad "找不到 dsh CLI"
command -v claude >/dev/null 2>&1 && ok "claude CLI" || warn "找不到 claude（autoloop 的 Claude agent 会不可用）"
command -v codex >/dev/null 2>&1 && ok "codex CLI" || warn "找不到 codex（autoloop 的 Codex agent 会不可用）"
command -v python3 >/dev/null 2>&1 && ok "python3 $(python3 --version 2>&1 | awk '{print $2}')" || warn "没有 python3（配置脚本会用到，建议装）"

section "agent-autoloop"
HOME_DIR="${AGENT_AUTOLOOP_HOME:-$HOME/.agent-autoloop}"
if [ -f "$HOME_DIR/config.json" ]; then ok "配置存在：$HOME_DIR/config.json"; else bad "缺少 $HOME_DIR/config.json（先跑 bin/install-autoloop.sh）"; fi
if command -v agent-autoloop >/dev/null 2>&1; then
  ok "agent-autoloop $(agent-autoloop --version 2>/dev/null | head -1)"
  if agent-autoloop check >/tmp/tieka-check.$$ 2>&1; then ok "rules.json 校验通过"; else bad "rules.json 校验失败：$(tail -3 /tmp/tieka-check.$$ | tr '\n' ' ')"; fi
  STATUS=$(agent-autoloop status 2>&1 || true)
  echo "$STATUS" | grep -q "中台 http" && ok "中台在线：$(echo "$STATUS" | grep -o '中台 http[^ ]*' | head -1)" || bad "中台没在跑（agent-autoloop service install / up）"
  echo "$STATUS" | grep -qE "等你 [0-9]+" && ok "状态可读（卡片/轮次）" || warn "status 输出异常"
  echo "$STATUS" | grep -q "Codex" && ok "Codex agent 已配置" || warn "rules.json 里没有 Codex agent"
  echo "$STATUS" | grep -q "Claude" && ok "Claude agent 已配置" || warn "rules.json 里没有 Claude agent"
  rm -f /tmp/tieka-check.$$
else
  bad "找不到 agent-autoloop 命令"
fi

section "DSH 插件"
for p in dsh-autoloop-panel dsh-agent-observer; do
  if [ -f "$DIR/plugins/$p/package.json" ]; then ok "插件包存在：plugins/$p"; else bad "缺少 plugins/$p"; fi
done
if [ -d "$HOME/.dsh/profiles/desktop/node_modules/@local" ]; then
  ls "$HOME/.dsh/profiles/desktop/node_modules/@local" 2>/dev/null | grep -q "dsh-autoloop-panel" && ok "面板已装进 desktop profile" || warn "面板未装进 profile（用 plugin_manager install_bundle）"
  ls "$HOME/.dsh/profiles/desktop/node_modules/@local" 2>/dev/null | grep -q "dsh-agent-observer" && ok "观察台已装进 desktop profile" || warn "观察台未装进 profile（用 plugin_manager install_bundle）"
else
  warn "看不到 ~/.dsh/profiles/desktop/node_modules/@local（profile 名可能不同）"
fi

section "任务发布机器人"
if [ -f "$HOME/.dsh-lark-bot/config.json" ]; then
  ok "bot 配置存在：$HOME/.dsh-lark-bot/config.json"
  LARKBIN=$(python3 -c "import json;print(json.load(open('$HOME/.dsh-lark-bot/config.json')).get('larkBin',''))" 2>/dev/null || echo "")
  [ -n "$LARKBIN" ] && ok "larkBin=$LARKBIN" || bad "config.json 缺 larkBin"
  OWNER=$(python3 -c "import json;print((json.load(open('$HOME/.dsh-lark-bot/config.json')).get('allowedUsers') or [''])[0])" 2>/dev/null || echo "")
  [ -n "$OWNER" ] && ok "白名单已有用户" || warn "白名单为空：去飞书给任务机器人发消息拿 open_id 后重跑 setup-task-bot --owner"
  LABEL="${DSH_LARK_BOT_LABEL:-com.tieka.dsh-lark-bot}"
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then ok "launchd 服务运行中"; else bad "dsh-lark-bot 服务未运行（botctl.sh install/start）"; fi
  if [ -n "$TASK_PROFILE" ]; then
    lark-cli event status 2>/dev/null | grep -A3 "$TASK_PROFILE" | grep -q "im.message.receive_v1" && ok "任务机器人事件监听已注册" || warn "event status 里没看到任务机器人的 consumer（profile=$TASK_PROFILE）"
  fi
else
  bad "缺少 ~/.dsh-lark-bot/config.json（先跑 feishu/setup-task-bot.sh）"
fi

section "审阅机器人 / autoloop 通道"
if [ -f "$HOME_DIR/lark-feishu.sh" ]; then ok "审阅通道 wrapper 存在"; else warn "缺少 $HOME_DIR/lark-feishu.sh（setup-review-bot.sh）"; fi
if [ -f "$HOME_DIR/config.json" ]; then
  CH=$(python3 - "$HOME_DIR/config.json" <<'PY' 2>/dev/null
import json,sys
c=json.load(open(sys.argv[1]))
ch=(c.get('channels') or {}).get('feishu')
print('yes' if ch and ch.get('key') and ch.get('user') else 'no')
PY
)
  [ "$CH" = "yes" ] && ok "config.json 的 channels.feishu 已配置" || warn "channels.feishu 缺 key/user（setup-review-bot.sh）"
fi
if [ -f "$HOME_DIR/rules.json" ]; then
  RS=$(python3 - "$HOME_DIR/rules.json" <<'PY' 2>/dev/null
import json,sys
r=json.load(open(sys.argv[1]))
ch=(r.get('channels') or {}).get('feishu') or {}
print('yes' if ch.get('name') and ch.get('answerers') else 'no')
PY
)
  [ "$RS" = "yes" ] && ok "rules.json 的审阅通道 answerers 已配置" || warn "rules.json 的 channels.feishu 缺 name/answerers"
fi
if [ -n "$REVIEW_PROFILE" ]; then
  lark-cli event status 2>/dev/null | grep -A3 "$REVIEW_PROFILE" | grep -q "card.action.trigger" && ok "审阅机器人卡片回调监听已注册" || warn "event status 里没看到审阅机器人的 card.action.trigger（profile=$REVIEW_PROFILE）"
fi

section "观察台汇报（需要 --dsh-url）"
if [ -n "$DSH_URL" ]; then
  BASE=$(echo "$DSH_URL" | sed 's#/*$##')
  if curl -s --max-time 6 "$BASE/agents/summary" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ok'))" 2>/dev/null | grep -qi true; then
    ok "GET $BASE/agents/summary 正常"
    AGENTS=$(curl -s --max-time 6 "$BASE/agents/summary" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(','.join(a['id'] for a in d['agents']))" 2>/dev/null)
    [ "$AGENTS" = "claude,codex,dsh" ] && ok "观察台只有 3 个 Agent：$AGENTS" || warn "Agents 列表：$AGENTS（预期 claude,codex,dsh）"
  else
    bad "GET $BASE/agents/summary 失败（端口不对 / DSH 没开 / 插件没装）"
  fi
  if curl -s --max-time 6 "$BASE/agents/notify/state" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d.get('hub',{}).get('configured'), d.get('report',{}).get('intervalSec'))" 2>/dev/null | grep -q "True"; then
    ok "观察台 notify 已连上 autoloop"
  else
    warn "观察台 notify 未看到 hub.configured=true（autoloop 配置/密钥）"
  fi
else
  warn "未提供 --dsh-url，跳过观察台路由检查（可从 DSH 运行时拿到 Web GUI 地址）"
fi

section "结论"
printf '  通过 %d 项，失败 %d 项，警告 %d 项\n' "$PASS" "$FAIL" "$WARN"
if [ "$FAIL" -gt 0 ]; then
  echo "  ❌ 有硬性失败，先按 docs/TROUBLESHOOTING.md 修"
  exit 1
fi
echo "  ✅ 后台链路全绿。还需要人工确认：DSH 侧栏「铁卡老弟」可见、飞书两个机器人收发正常。"
exit 0
