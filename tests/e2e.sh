#!/bin/bash
# ============================================================================
# tieka-console · 安装后流程化验收（E2E）
#
# 在**完成 INSTALL.md 全部步骤之后**跑，逐层验证「飞书 → 中控 → Agent → 飞书」
# 是否真的跑通。默认只做只读检查；加 --with-feishu / --with-task-simulate
# 才会真的发飞书消息（需要你在飞书里确认）。
#
# 用法：
#   bash tests/e2e.sh                          # 只读：环境/中台/插件/机器人配置
#   bash tests/e2e.sh --dsh-url http://127.0.0.1:64130
#   bash tests/e2e.sh --with-feishu            # 真发测试卡 + 审阅机器人通知
#   bash tests/e2e.sh --with-task-simulate     # 走一遍任务机器人完整链路（真执行、真回飞书）
#   bash tests/e2e.sh --with-feishu --with-task-simulate --yes   # 全自动（不再逐项确认）
#
# 选项：
#   --dsh-url URL          DSH Web GUI 地址；不给就自动扫描本机监听端口找 /autoloop/meta
#   --task-label LABEL     任务机器人的 launchd label（默认 com.tieka.dsh-lark-bot）
#   --bot-config PATH      任务机器人 config.json（默认 $DSH_LARK_BOT_CONFIG 或 ~/.dsh-lark-bot/config.json）
#   --with-feishu          真发：观察台测试卡 + 30 分钟汇报 + autoloop 通知卡（会问你收到没）
#   --with-task-simulate   真跑：node bot.mjs --simulate（需要 config 里 testChatId；会发真消息）
#   --skip-report          --with-feishu 时不发 30 分钟汇报（少一条）
#   --skip-dsh-exec        不跑 `dsh --profile headless` 冒烟（默认会跑一次，约 10–30 秒）
#   --yes                  所有人工确认自动当作「已收到」（只适合 CI/你自己盯着飞书）
#   --timeout SEC          单次 HTTP 超时（默认 15）
#   -h, --help
# 退出码：0 全过（含人工确认通过）；1 有 ❌；2 参数错误。
# ============================================================================
set -uo pipefail

KIT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DSH_URL=""
TASK_LABEL="com.tieka.dsh-lark-bot"
BOT_CONFIG=""
WITH_FEISHU=0
WITH_TASK_SIMULATE=0
SKIP_REPORT=0
SKIP_DSH_EXEC=0
YES=0
ALLOW_EXTRA=0
TIMEOUT=15

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-url) DSH_URL="${2:-}"; shift 2 ;;
    --task-label) TASK_LABEL="${2:-}"; shift 2 ;;
    --bot-config) BOT_CONFIG="${2:-}"; shift 2 ;;
    --with-feishu) WITH_FEISHU=1; shift ;;
    --with-task-simulate) WITH_TASK_SIMULATE=1; shift ;;
    --skip-report) SKIP_REPORT=1; shift ;;
    --skip-dsh-exec) SKIP_DSH_EXEC=1; shift ;;
    --allow-extra-agents) ALLOW_EXTRA=1; shift ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    --yes) YES=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（-h 看用法）" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0; WARN=0; FAILED_ITEMS=()
AUTOLOOP_HOME="${AGENT_AUTOLOOP_HOME:-$HOME/.agent-autoloop}"
AUTOLOOP_CONFIG="$AUTOLOOP_HOME/config.json"
AUTOLOOP_RULES="$AUTOLOOP_HOME/rules.json"

ok()   { PASS=$((PASS+1)); printf '  ✅ %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); FAILED_ITEMS+=("$*"); printf '  ❌ %s\n' "$*"; }
warn() { WARN=$((WARN+1)); printf '  ⚠️  %s\n' "$*"; }
section() { printf '\n== %s ==\n' "$*"; }

# JSON 字段读取（用 node，保证目标机器一定有；空串=取不到）
jget() { # $1=表达式（作用于 o），stdin=JSON
  EXPR="$1" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=new Function("o","return ("+process.env.EXPR+")")(o);process.stdout.write(v===undefined||v===null?"":String(v))}catch(e){process.stdout.write("")}})' 2>/dev/null
}
is_true() { [ "$1" = "true" ]; }

# 人类确认：$1=要确认的内容；返回 0=确认
confirm() {
  if [ "$YES" = 1 ]; then
    warn "已发送，--yes 模式未人工确认：$1（请自己看一眼飞书）"
    return 0
  fi
  if [ ! -t 0 ]; then
    warn "非交互终端，跳过人工确认：$1"
    return 0
  fi
  local ans
  read -r -p "  👀 请确认 $1 —— 收到了吗？[y/N] " ans
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ---------- 0. 环境 ----------
section "0. 环境"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node --version | sed 's/^v//;s/\..*//')
  [ "${NODE_MAJOR:-0}" -ge 24 ] && ok "Node $(node --version)" || bad "Node $(node --version)（autoloop 需要 ≥ 24）"
else bad "找不到 node"; fi
for c in curl lark-cli agent-autoloop dsh; do
  command -v "$c" >/dev/null 2>&1 && ok "$c 已安装（$(command -v "$c")）" || bad "找不到 $c"
done
if [ -f "$AUTOLOOP_CONFIG" ]; then ok "autoloop 配置：$AUTOLOOP_CONFIG"; else bad "缺少 ${AUTOLOOP_CONFIG}（先完成 INSTALL 第 2 步）"; fi

# ---------- 1. autoloop 中台 ----------
section "1. agent-autoloop 中台"
HUB_URL=""; HUB_OWNER=""
if [ -f "$AUTOLOOP_CONFIG" ]; then
  HUB_URL=$(jget 'o.url || ""' < "$AUTOLOOP_CONFIG")
  HUB_OWNER=$(jget 'o.owner || ""' < "$AUTOLOOP_CONFIG")
  [ -n "$HUB_URL" ] && ok "中台地址：$HUB_URL" || bad "config.json 没有 url"
  [ -n "$HUB_OWNER" ] && ok "owner 密钥已配置" || bad "config.json 没有 owner 密钥（这台机器可能只是接单端）"
  FEISHU_CH=$(jget 'JSON.stringify((o.channels||{}).feishu||{})' < "$AUTOLOOP_CONFIG")
else
  FEISHU_CH=""
  warn "跳过中台检查（没有 config.json）"
fi
if command -v agent-autoloop >/dev/null 2>&1; then
  if agent-autoloop check >/tmp/e2e-check.$$ 2>&1; then ok "rules.json 校验通过"; else bad "rules.json 校验失败：$(tail -2 /tmp/e2e-check.$$ | tr '\n' ' ')"; fi
  rm -f /tmp/e2e-check.$$
  STATUS_TXT=$(agent-autoloop status 2>&1 || true)
  echo "$STATUS_TXT" | grep -q "●" && ok "中台有在线对象（Agent/通道）" || bad "agent-autoloop status 没有在线对象（中台没在跑）"
  echo "$STATUS_TXT" | grep -q "飞书" && ok "飞书通道已注册" || warn "status 里没看到飞书通道（还没接审阅机器人？）"
  if [ "$(uname)" = "Darwin" ]; then
    if launchctl print "gui/$(id -u)/agent-autoloop" >/dev/null 2>&1; then ok "autoloop launchd 服务在运行"; else warn "autoloop 系统服务未注册（可能用了 --no-service）"; fi
  fi
fi
[ -f "$AUTOLOOP_RULES" ] && ok "rules.json 存在" || { bad "缺少 $AUTOLOOP_RULES"; }
if [ -f "$AUTOLOOP_RULES" ]; then
  A_COUNT=$(jget 'Object.keys(o.agents||{}).length' < "$AUTOLOOP_RULES")
  R_COUNT=$(jget 'Array.isArray(o.rules)?o.rules.length:0' < "$AUTOLOOP_RULES")
  [ "${A_COUNT:-0}" -ge 3 ] && ok "已配置 ${A_COUNT} 个 Agent（期望 ≥3：DSH/Claude/Codex）" || bad "Agent 只有 ${A_COUNT} 个（期望 DSH/Claude/Codex）"
  [ "${R_COUNT:-0}" -ge 1 ] && ok "已配置 ${R_COUNT} 条规则" || bad "rules.json 里没有规则"
fi
if [ -n "$HUB_URL" ] && [ -n "$HUB_OWNER" ]; then
  HUB_STATE=$(curl -sS -m "$TIMEOUT" -H "authorization: Bearer $HUB_OWNER" "$HUB_URL/v1/state" 2>/dev/null || true)
  [ "$(printf '%s' "$HUB_STATE" | jget '(o&&!o.error&&(o.now||o.totals))?"true":"false"')" = "true" ] && ok "owner 密钥可读中台 /v1/state" || bad "owner 密钥读 /v1/state 失败（密钥不匹配或中台没起）"
fi

# ---------- 2. DSH 中控台（自动发现端口） ----------
section "2. DSH 中控台（面板 + 观察台）"
probe_meta() { curl -sS -m 2 "http://127.0.0.1:$1/autoloop/meta" 2>/dev/null | jget 'o.ok===true?"true":"false"'; }
if [ -n "$DSH_URL" ]; then
  BASE=$(printf '%s' "$DSH_URL" | sed 's#/*$##')
  if [ "$(curl -sS -m "$TIMEOUT" "$BASE/autoloop/meta" 2>/dev/null | jget 'o.ok===true?"true":"false"')" = "true" ]; then
    ok "指定 --dsh-url 可用：$BASE"
  else
    bad "指定的 DSH 地址不可用：$BASE/autoloop/meta（DSH 没开 / 面板没装？）"
    BASE=""
  fi
else
  BASE=""
  PORTS=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {split($9,a,":"); print a[length(a)]}' | grep -E '^[0-9]+$' | sort -un)
  for p in $PORTS; do
    [ "$p" = "3350" ] && continue
    if [ "$(probe_meta "$p")" = "true" ]; then BASE="http://127.0.0.1:$p"; break; fi
  done
  [ -n "$BASE" ] && ok "自动发现 DSH Web GUI：$BASE" || bad "没找到 DSH（面板路由 /autoloop/meta 无响应）。确认 DSH 在运行、面板已装并启用"
fi
if [ -n "$BASE" ]; then
  META=$(curl -sS -m "$TIMEOUT" "$BASE/autoloop/meta" 2>/dev/null || true)
  [ "$(printf '%s' "$META" | jget 'o.ok===true?"true":"false"')" = "true" ] && ok "面板 Host 路由 /autoloop/meta" || bad "面板 Host 路由 /autoloop/meta 异常"
  [ "$(printf '%s' "$META" | jget 'o.data&&o.data.hasOwner?"true":"false"')" = "true" ] && ok "面板已读到 owner 密钥（hasOwner）" || bad "面板 hasOwner=false（autoloop config 的 owner 缺失）"
  STATE=$(curl -sS -m "$TIMEOUT" "$BASE/autoloop/state" 2>/dev/null || true)
  [ "$(printf '%s' "$STATE" | jget 'o.ok===true?"true":"false"')" = "true" ] && ok "面板 /autoloop/state 可读" || bad "面板 /autoloop/state 异常"
  RULES=$(curl -sS -m "$TIMEOUT" "$BASE/autoloop/rules" 2>/dev/null || true)
  [ "$(printf '%s' "$RULES" | jget 'o.ok===true?"true":"false"')" = "true" ] && ok "面板 /autoloop/rules 可读" || bad "面板 /autoloop/rules 异常"

  SUMMARY=$(curl -sS -m "$TIMEOUT" "$BASE/agents/summary" 2>/dev/null || true)
  if [ "$(printf '%s' "$SUMMARY" | jget 'o.ok===true?"true":"false"')" = "true" ]; then
    IDS=$(printf '%s' "$SUMMARY" | jget '(o.data.agents||[]).map(a=>a.id).sort().join(",")')
    if [ "$IDS" = "claude,codex,dsh" ]; then
      ok "观察台 3 个 Agent：$IDS"
    elif [ "$ALLOW_EXTRA" = 1 ] && printf '%s' "$IDS" | grep -q "claude" && printf '%s' "$IDS" | grep -q "codex" && printf '%s' "$IDS" | grep -q "dsh"; then
      warn "观察台 Agent 含额外项：${IDS}（--allow-extra-agents 放行；目标安装应为 lite 三件套）"
    else
      bad "观察台 Agent 列表异常：${IDS}（期望 claude,codex,dsh；是不是装成了完整版/没装？）"
    fi
  else
    bad "观察台 /agents/summary 不可用（插件没装/没启用）"
  fi
  STEPS=$(curl -sS -m "$TIMEOUT" "$BASE/agents/dsh/steps?limit=2" 2>/dev/null || true)
  [ "$(printf '%s' "$STEPS" | jget 'o.ok===true?"true":"false"')" = "true" ] && ok "观察台 /agents/dsh/steps 可读" || bad "观察台 /agents/dsh/steps 异常"
  NSTATE=$(curl -sS -m "$TIMEOUT" "$BASE/agents/notify/state" 2>/dev/null || true)
  if [ "$(printf '%s' "$NSTATE" | jget 'o.ok===true?"true":"false"')" = "true" ]; then
    [ "$(printf '%s' "$NSTATE" | jget 'o.data&&o.data.hub&&o.data.hub.configured?"true":"false"')" = "true" ] && ok "观察台已连上 autoloop（hub.configured）" || bad "观察台没连上 autoloop（source key/配置缺失）"
    RIP=$(printf '%s' "$NSTATE" | jget 'o.data&&o.data.report?o.data.report.intervalSec:""')
    [ -n "$RIP" ] && ok "30 分钟汇报配置：intervalSec=${RIP}s" || warn "读不到汇报间隔（可能还没配置）"
  else
    bad "观察台 /agents/notify/state 不可用"
  fi
  # lite 版契约：截图路由必须不存在
  SNAP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -m "$TIMEOUT" "$BASE/agents/claude/snapshot.png" 2>/dev/null)
  [ "$SNAP_CODE" = "404" ] && ok "lite 观察台无截图路由（404，符合预期）" || warn "截图路由返回 ${SNAP_CODE}（完整版观察台？）"
fi

# ---------- 3. 飞书「审阅机器人」（可选真发） ----------
section "3. 飞书「审阅机器人」链路"
if [ "$WITH_FEISHU" = 1 ] && [ -n "$BASE" ]; then
  TESTRES=$(curl -sS -m "$TIMEOUT" -X POST "$BASE/agents/notify/test" 2>/dev/null || true)
  if [ "$(printf '%s' "$TESTRES" | jget 'o.ok===true?"true":"false"')" = "true" ]; then
    ok "观察台测试通知已提交（POST /agents/notify/test）"
    confirm "飞书「审阅机器人」收到一条测试卡片/通知" || bad "飞书「审阅机器人」没有收到测试卡"
  else
    bad "观察台测试通知失败：$(printf '%s' "$TESTRES" | head -c 300)"
  fi
  if [ "$SKIP_REPORT" = 0 ]; then
    REPRES=$(curl -sS -m "$TIMEOUT" -X POST "$BASE/agents/notify/report" 2>/dev/null || true)
    if [ "$(printf '%s' "$REPRES" | jget 'o.ok===true?"true":"false"')" = "true" ]; then
      ok "30 分钟汇报已提交（POST /agents/notify/report）"
      confirm "飞书「审阅机器人」收到 Agent 运行汇报（Claude/Codex/DSH 三行）" || bad "飞书「审阅机器人」没有收到汇报"
    else
      bad "汇报发送失败：$(printf '%s' "$REPRES" | head -c 300)"
    fi
  else
    warn "按 --skip-report 跳过 30 分钟汇报测试"
  fi
  if command -v agent-autoloop >/dev/null 2>&1; then
    if printf 'tieka E2E 通知卡 %s\n（若看到这条，说明 autoloop → 审阅机器人 通道正常）\n' "$(date '+%Y-%m-%d %H:%M:%S')" | agent-autoloop tell "e2e-$(date +%s)" >/tmp/e2e-tell.$$ 2>&1; then
      ok "autoloop tell 通知卡已提交"
      confirm "飞书「审阅机器人」收到一张「通知卡（e2e-…）」" || bad "飞书「审阅机器人」没有收到通知卡"
    else
      bad "autoloop tell 失败：$(tail -2 /tmp/e2e-tell.$$ | tr '\n' ' ')"
    fi
    rm -f /tmp/e2e-tell.$$
  fi
else
  warn "未发真实飞书消息（加 --with-feishu 才测审阅机器人投递）"
fi

# ---------- 4. 飞书「任务发布机器人」 ----------
section "4. 飞书「任务发布机器人」链路"
BOT_DIR="$KIT_DIR/bots/dsh-lark-bot"
if [ -z "$BOT_CONFIG" ]; then
  if [ -n "${DSH_LARK_BOT_CONFIG:-}" ]; then BOT_CONFIG="$DSH_LARK_BOT_CONFIG"
  elif [ -f "$HOME/.dsh-lark-bot/config.json" ]; then BOT_CONFIG="$HOME/.dsh-lark-bot/config.json"
  elif [ -f "$BOT_DIR/config.json" ]; then BOT_CONFIG="$BOT_DIR/config.json"; fi
fi
if [ -f "$BOT_DIR/bot.mjs" ]; then ok "任务机器人代码存在：$BOT_DIR/bot.mjs"; else bad "缺少 $BOT_DIR/bot.mjs"; fi
if [ -n "$BOT_CONFIG" ] && [ -f "$BOT_CONFIG" ]; then
  ok "任务机器人配置：$BOT_CONFIG"
  LARKBIN=$(jget 'o.larkBin||""' < "$BOT_CONFIG")
  OWNER0=$(jget '(o.allowedUsers||[])[0]||""' < "$BOT_CONFIG")
  TESTCHAT=$(jget 'o.testChatId||""' < "$BOT_CONFIG")
  PROFILE=""
  [ -n "$LARKBIN" ] && [ -x "$LARKBIN" ] && ok "larkBin wrapper 可执行：$LARKBIN" || bad "larkBin 不存在/不可执行：$LARKBIN"
  if [ -n "$LARKBIN" ] && [ -f "$LARKBIN" ]; then
    PROFILE=$(grep -o -- '--profile[ =][^ "]*' "$LARKBIN" 2>/dev/null | head -1 | sed 's/^--profile[ =]//')
    [ -n "$PROFILE" ] && ok "固定 lark-cli profile：$PROFILE" || warn "wrapper 里没解析到 --profile"
  fi
  [ -n "$OWNER0" ] && ok "白名单已配置（allowedUsers[0] 非空）" || bad "白名单为空：去飞书给任务机器人发一句话拿 open_id，然后 setup-task-bot --owner 重配"
  [ -n "$TESTCHAT" ] && ok "testChatId 已配置（可做 --simulate 端到端）" || warn "testChatId 为空：--with-task-simulate 需要它（取任务机器人会话 chat_id）"
  if [ -n "$PROFILE" ] && command -v lark-cli >/dev/null 2>&1; then
    AUTH=$(lark-cli --profile "$PROFILE" auth status 2>/dev/null || true)
    [ "$(printf '%s' "$AUTH" | jget '(o.identities&&o.identities.bot&&o.identities.bot.status)==="ready"?"true":"false"')" = "true" ] && ok "lark-cli bot 身份就绪（${PROFILE}）" || bad "lark-cli bot 身份未就绪（${PROFILE}）：lark-cli --profile $PROFILE auth status"
  fi
  # 事件监听：用 profile 的 appId 匹配 event status（event status 按 appId 分组，不显示 profile 名）
  if [ -n "$PROFILE" ] && command -v lark-cli >/dev/null 2>&1; then
    AUTH2=$(lark-cli --profile "$PROFILE" auth status 2>/dev/null || true)
    APPID=$(printf '%s' "$AUTH2" | jget 'o.appId||""')
    if [ -n "$APPID" ]; then
      EV=$(lark-cli event status 2>/dev/null || true)
      printf '%s' "$EV" | grep -q "$APPID" && printf '%s' "$EV" | grep -q "im.message.receive_v1" && ok "事件监听 im.message.receive_v1 已注册（${APPID}）" || bad "app $APPID 没有 im.message.receive_v1 consumer（机器人没启动/没订阅事件）"
    else
      warn "读不到 profile 的 appId，跳过事件监听检查"
    fi
  fi
  # launchd / systemd
  if [ "$(uname)" = "Darwin" ]; then
    if launchctl print "gui/$(id -u)/$TASK_LABEL" >/dev/null 2>&1; then ok "launchd 服务运行中：$TASK_LABEL"; else bad "服务未运行：${TASK_LABEL}（bots/dsh-lark-bot/botctl.sh install）"; fi
  else
    systemctl --user is-active dsh-lark-bot >/dev/null 2>&1 && ok "systemd 服务运行中" || warn "Linux 请自行确认 dsh-lark-bot 服务（systemctl --user）"
  fi
  # doctor（只读）
  if [ -f "$BOT_DIR/bot.mjs" ]; then
    if DSH_LARK_BOT_CONFIG="$BOT_CONFIG" node "$BOT_DIR/bot.mjs" --doctor >/tmp/e2e-doctor.$$ 2>&1; then
      ok "bot.mjs --doctor 自检通过"
    else
      bad "bot.mjs --doctor 有失败项：$(grep -E '❌|✗|失败' /tmp/e2e-doctor.$$ | head -3 | tr '\n' ' ')"
    fi
    rm -f /tmp/e2e-doctor.$$
  fi

  if [ "$WITH_TASK_SIMULATE" = 1 ]; then
    if [ -z "$TESTCHAT" ]; then
      bad "--with-task-simulate 需要 config 里 testChatId：把任务机器人会话 chat_id 填进 $BOT_CONFIG 后重跑"
    else
      echo "  ⏳ 正在走任务机器人完整链路（会真实调用 DSH 并往飞书发消息，约 10–60 秒）…"
      if DSH_LARK_BOT_CONFIG="$BOT_CONFIG" node "$BOT_DIR/bot.mjs" --simulate "端到端测试：请只回一句「铁卡老弟链路正常」" >/tmp/e2e-sim.$$ 2>&1; then
        grep -q '\[simulate\] 完成' /tmp/e2e-sim.$$ && ok "simulate 完整链路跑完（模拟入站 → DSH 执行 → 飞书回传）" || warn "simulate 退出 0 但没看到完成标记"
        confirm "飞书「任务发布机器人」会话收到测试回复（含「铁卡老弟链路正常」）" || bad "任务机器人没有在飞书回消息（看 /tmp/e2e-sim.* 与 ~/.dsh-lark-bot/logs）"
      else
        bad "simulate 失败：$(tail -3 /tmp/e2e-sim.$$ | tr '\n' ' ')"
      fi
      rm -f /tmp/e2e-sim.$$
    fi
  else
    warn "未跑任务机器人完整链路（加 --with-task-simulate；会真执行一次）"
  fi
else
  bad "找不到任务机器人配置（先完成 INSTALL 第 6 步，或 --bot-config 指定）"
fi

# ---------- 5. DSH headless 冒烟 ----------
section "5. DSH headless 执行冒烟"
if [ "$SKIP_DSH_EXEC" = 1 ]; then
  warn "按 --skip-dsh-exec 跳过"
else
  echo "  ⏳ 正在跑 dsh --profile headless（约 10–30 秒，消耗少量模型额度）…"
  if timeout 120 dsh --profile headless --json "只回答一个词：E2E_OK" >/tmp/e2e-dsh.$$ 2>&1; then
    grep -q "E2E_OK" /tmp/e2e-dsh.$$ && ok "DSH headless 能执行并返回结果" || warn "dsh 退出 0 但没看到 E2E_OK（模型/网络？）"
  else
    bad "dsh --profile headless 执行失败（看 /tmp/e2e-dsh.*）"
  fi
  rm -f /tmp/e2e-dsh.$$
fi

# ---------- 结论 ----------
section "结论"
printf '  通过 %d 项，失败 %d 项，警告 %d 项\n' "$PASS" "$FAIL" "$WARN"
if [ "$FAIL" -gt 0 ]; then
  echo "  ❌ 有硬性失败："
  for item in "${FAILED_ITEMS[@]}"; do echo "     - $item"; done
  echo "  排障：docs/TROUBLESHOOTING.md；再看 ~/.agent-autoloop/logs/ 与 ~/.dsh-lark-bot/logs/"
  exit 1
fi
cat <<'EOF'
  ✅ 自动化链路全过。还需要人眼确认的（脚本无法替你点）：
     1) DSH 侧栏「铁卡老弟」图标存在、面板总览有轮次/花费
     2) 飞书「审阅机器人」卡片里的按钮点一下，autoloop 相应轮次继续
     3) 飞书「任务发布机器人」真实发一句「你好」，能收到回复
  首次通过后，建议把这份输出存档；以后重启/升级后重跑本脚本即可体检。
EOF
exit 0
