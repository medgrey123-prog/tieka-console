#!/usr/bin/env bash
# tieka-console · 审阅机器人接入脚本（agent-autoloop 的飞书通道）
#
# 做六件事（幂等，可重复运行）：
#   1) 在 lark-cli 里创建/复用「审阅机器人」应用的 profile（App Secret 从 stdin 或终端无回显读）
#   2) 拿到你的 user open_id：--owner 传入，或 --login 扫码后自动读取
#   3) 写 wrapper：$HOME/.agent-autoloop/lark-feishu.sh（固定 profile 的 lark-cli 入口）
#   4) 生成/复用 autoloop 通道密钥（agent-autoloop key new channel feishu）
#   5) patch ~/.agent-autoloop/config.json 的 channels.feishu {key,user,lark}
#   6) 备份并 patch rules.json 的 channels.feishu {name:"审阅机器人", answerers:[owner]}，然后 agent-autoloop check
#
# 安全：先备份再改；agent-autoloop check 失败自动恢复 config.json/rules.json。
# 不做：不 sudo、不装依赖、不重启中台（只提示重启命令）、不动别的 lark-cli profile。
set -euo pipefail

SELF_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KIT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB="$SCRIPT_DIR/lib/common.sh"

[ -f "$LIB" ] || { echo "❌ 套件不完整：缺少 $LIB" >&2; exit 1; }
# shellcheck source=lib/common.sh
. "$LIB"

PROFILE=""
APP_ID=""
OWNER=""
DO_LOGIN=0
ROTATE_KEY=0
FORCE_PROFILE=0
DRY_RUN="${DRY_RUN:-0}"

CHANNEL_NAME="审阅机器人"

usage() {
  cat <<'EOF'
用法：bash feishu/setup-review-bot.sh --profile <name> [--app-id <id>] (--owner <open_id> | --login) [选项]

把「审阅机器人」（飞书消息卡片 / 审批 / 汇报）接进本机 agent-autoloop。

必填：
  --profile <name>      lark-cli profile 名（建议 tieka-review）
  --app-id <id>         飞书应用 App ID（cli_ 开头）；profile 已存在时可省略，此时必须给 --owner 或 --login

二选一（怎么拿你的 open_id）：
  --owner <open_id>     直接传入（ou_ 开头）
  --login               自动执行 lark-cli auth login（扫码/浏览器授权），读回 user open_id；
                        脚本会打印一行 OPEN_ID=ou_xxx

可选：
  --rotate-key          重新生成 autoloop 通道密钥（默认复用 config.json 里已有的）
  --force-profile       profile 同名但 App ID 不同时，删除旧 profile 后重建
  --dry-run             只打印计划：不写文件、不建 profile、不改 autoloop 配置
  -h, --help            显示本帮助

App Secret 传法（二选一，不要贴在命令行参数里）：
  printf '%s' "$SECRET" | bash feishu/setup-review-bot.sh --profile tieka-review --app-id cli_xxx --login
  直接运行脚本，按提示粘贴（输入不回显）

说明：
  - profile 已存在且 App ID 一致时会跳过创建，所以第二次运行无需再传 Secret。
  - 改完 config.json 必须重启一次中台才生效，脚本末尾会打印重启命令。
  - check 失败会自动恢复安装前的 config.json / rules.json。

环境变量：
  TIEKA_HOME             仅测试用：把文件写进临时沙箱（同时覆盖 HOME）
  AGENT_AUTOLOOP_HOME    覆盖 autoloop 安装目录（默认 $HOME/.agent-autoloop）
  AGENT_AUTOLOOP_RULES   覆盖 rules.json 路径（测试用）
EOF
}

# 失败回滚
ROLLBACK_ACTIVE=0
CFG_BACKUP=""
RULES_BACKUP=""
restore_backups() {
  if [ -n "$CFG_BACKUP" ] && [ -f "$CFG_BACKUP" ]; then
    cp -p "$CFG_BACKUP" "$AUTOLOOP_CONFIG" 2>/dev/null && chmod 600 "$AUTOLOOP_CONFIG" 2>/dev/null || true
  fi
  if [ -n "$RULES_BACKUP" ] && [ -f "$RULES_BACKUP" ]; then
    cp -p "$RULES_BACKUP" "$AUTOLOOP_RULES" 2>/dev/null || true
  fi
}
warn_key_mismatch() {
  if [ "${KEY_ACTION:-}" = "new" ] && [ -n "${EXISTING_KEY:-}" ]; then
    warn "注意：本轮已生成新通道密钥（旧通道密钥在 autoloop 里已失效），但配置已回滚成旧 key。"
    warn "修好问题后请重跑并加 --rotate-key，让 config.json 里的 key 与新密钥一致。"
  fi
}

on_exit() {
  local code=$?
  if [ "$ROLLBACK_ACTIVE" = "1" ]; then
    warn "安装失败，正在回滚 config.json / rules.json …"
    restore_backups
    warn "已回滚到安装前状态。若本轮生成过新通道密钥，它在 autoloop 里但仍未被引用，可清理：agent-autoloop key remove channel feishu"
    warn_key_mismatch
    warn "确认没有残留：agent-autoloop check"
  fi
  exit "$code"
}
trap on_exit EXIT

# ---------------------------------------------------------------- 参数
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --login) DO_LOGIN=1; shift ;;
    --rotate-key) ROTATE_KEY=1; shift ;;
    --force-profile) FORCE_PROFILE=1; shift ;;
    --profile)
      [ $# -ge 2 ] || fail "--profile 需要一个值"
      PROFILE="$2"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --app-id)
      [ $# -ge 2 ] || fail "--app-id 需要一个值"
      APP_ID="$2"; shift 2 ;;
    --app-id=*) APP_ID="${1#*=}"; shift ;;
    --owner)
      [ $# -ge 2 ] || fail "--owner 需要一个值"
      OWNER="$2"; shift 2 ;;
    --owner=*) OWNER="${1#*=}"; shift ;;
    *) fail "不认识的参数：${1}（bash $SELF_NAME --help 查看用法）" ;;
  esac
done

print_banner "审阅机器人（agent-autoloop 飞书通道）安装"

# ---------------------------------------------------------------- 0. 预检
step "0. 检查输入与环境"
[ -n "$PROFILE" ] || fail "缺少 --profile（bash $SELF_NAME --help 查看用法）"
validate_profile_name "$PROFILE"
validate_app_id "$APP_ID"
validate_owner "$OWNER"
if [ -z "$OWNER" ] && [ "$DO_LOGIN" != "1" ]; then
  fail "缺少 --owner（或加 --login 自动扫码获取）。先跑任务发布机器人安装脚本、给机器人发消息也能拿到你的 open_id。"
fi
require_node
require_lark_cli

AUTOLOOP_HOME="${AGENT_AUTOLOOP_HOME:-$TARGET_HOME/.agent-autoloop}"
AUTOLOOP_CONFIG="$AUTOLOOP_HOME/config.json"
AUTOLOOP_RULES="${AGENT_AUTOLOOP_RULES:-$AUTOLOOP_HOME/rules.json}"
WRAPPER="$AUTOLOOP_HOME/lark-feishu.sh"

if is_dry; then
  if ! have agent-autoloop; then warn "dry-run：本机没有 agent-autoloop（真装时先 bash bin/install-autoloop.sh）"; fi
  [ -f "$AUTOLOOP_CONFIG" ] || warn "dry-run：$AUTOLOOP_CONFIG 不存在（真装时先装 agent-autoloop）"
  [ -f "$AUTOLOOP_RULES" ] || warn "dry-run：$AUTOLOOP_RULES 不存在（真装时先装 agent-autoloop）"
else
  have agent-autoloop || fail "找不到 agent-autoloop。先安装：bash bin/install-autoloop.sh"
  [ -f "$AUTOLOOP_CONFIG" ] || fail "没找到 ${AUTOLOOP_CONFIG}：agent-autoloop 还没装好（bash bin/install-autoloop.sh）"
  [ -f "$AUTOLOOP_RULES" ] || fail "没找到 ${AUTOLOOP_RULES}：agent-autoloop 还没装好（bash bin/install-autoloop.sh）"
  json_valid "$AUTOLOOP_CONFIG" || fail "$AUTOLOOP_CONFIG 不是合法 JSON，先修好再装（备份：*.bak-*）"
  json_valid "$AUTOLOOP_RULES" || fail "$AUTOLOOP_RULES 不是合法 JSON，先修好再装（备份：*.bak-*）"
  ok "agent-autoloop：$(command -v agent-autoloop)"
  ok "autoloop 目录：$AUTOLOOP_HOME"
fi

# ---------------------------------------------------------------- 1. profile
step "1. lark-cli profile"
plan_profile "$PROFILE" "$FORCE_PROFILE"
apply_profile

# ---------------------------------------------------------------- 2. owner open_id
step "2. 你的 open_id（谁可以在飞书里点按钮/回答问题）"
auth_user_open_id() {
  { lark-cli --profile "$PROFILE" auth status --json 2>/dev/null || true; } | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }
  const u = data && data.identities && data.identities.user;
  if (u && u.openId) process.stdout.write(String(u.openId));
});
'
}

if [ -n "$OWNER" ]; then
  ok "使用 --owner：$OWNER"
else
  if is_dry; then
    info "[dry-run] 将执行：lark-cli --profile $PROFILE auth login --domain im（扫码/浏览器授权）"
    info "[dry-run] 然后用 lark-cli --profile $PROFILE auth status --json 读取 identities.user.openId"
    OWNER="<OPEN_ID>"
  else
    say ""
    say "即将进行飞书授权：终端会打印授权链接/二维码，用【你的飞书】扫码并确认（只申请 im 相关最小权限）。"
    say "如果卡住不动：Ctrl+C 后改用 --owner <open_id> 手动传入，重跑脚本即可（profile 不会重复创建）。"
    lark-cli --profile "$PROFILE" auth login --domain im \
      || fail "lark-cli auth login 失败/超时。可改用 --owner <open_id> 手动传入后重跑"
    OWNER="$(auth_user_open_id)"
    [ -n "$OWNER" ] || fail "登录流程结束但没读到 user openId。可改用 --owner <open_id> 传入（任务发布机器人的未授权回复里有你的 open_id）"
    ok "授权完成，读到 user open_id"
  fi
fi
validate_owner "$OWNER"

# ---------------------------------------------------------------- 3. wrapper
step "3. autoloop 飞书 wrapper（config.json 的 channels.feishu.lark 指向它）"
if is_dry && [ ! -f "$AUTOLOOP_CONFIG" ]; then info "[dry-run] 目录：$AUTOLOOP_HOME"; fi
write_lark_wrapper "$WRAPPER" "$PROFILE" "审阅机器人（agent-autoloop 飞书通道）"

# ---------------------------------------------------------------- 4. 通道密钥
step "4. autoloop 通道密钥（channel feishu）"
CHANNEL_KEY=""
KEY_ACTION=""
EXISTING_KEY=""
if [ -f "$AUTOLOOP_CONFIG" ]; then
  EXISTING_KEY="$(json_get "$AUTOLOOP_CONFIG" channels.feishu.key)"
fi
if [ -n "$EXISTING_KEY" ] && [ "$ROTATE_KEY" != "1" ]; then
  CHANNEL_KEY="$EXISTING_KEY"
  KEY_ACTION="keep"
  ok "复用 config.json 里已有的 channels.feishu.key（要轮换加 --rotate-key）"
else
  KEY_ACTION="new"
  if is_dry; then
    info "[dry-run] 将执行：agent-autoloop key new channel feishu"
    CHANNEL_KEY="<CHANNEL_KEY>"
  else
    info "生成新的 autoloop 通道密钥（只写本机 config.json，不打印全文）…"
    OUT="$(agent-autoloop key new channel feishu)" || fail "agent-autoloop key new channel feishu 失败"
    CHANNEL_KEY="$(printf '%s\n' "$OUT" | tail -n 1 | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    case "$CHANNEL_KEY" in
      ""|*[!A-Za-z0-9_-]*) fail "agent-autoloop key new 输出异常，没拿到可用密钥（长度 ${#CHANNEL_KEY}）" ;;
    esac
    [ "${#CHANNEL_KEY}" -ge 20 ] || fail "agent-autoloop key new 输出太短，不像密钥（长度 ${#CHANNEL_KEY}）"
    ok "通道密钥已生成（长度 ${#CHANNEL_KEY}）"
  fi
fi
if [ "$KEY_ACTION" = "keep" ]; then
  case "$CHANNEL_KEY" in
    ""|*[!A-Za-z0-9_-]*) fail "config.json 里的 channels.feishu.key 看起来不合法；加 --rotate-key 重新生成" ;;
  esac
  [ "${#CHANNEL_KEY}" -ge 20 ] || fail "config.json 里的 channels.feishu.key 太短；加 --rotate-key 重新生成"
fi

# ---------------------------------------------------------------- 5/6. patch config + rules
PATCH_CONFIG='
const fs = require("fs");
const [file, key, user, lark, mode] = process.argv.slice(1);
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
cfg.channels = cfg.channels && typeof cfg.channels === "object" ? cfg.channels : {};
const prev = cfg.channels.feishu && typeof cfg.channels.feishu === "object" ? cfg.channels.feishu : {};
cfg.channels.feishu = Object.assign({}, prev, { key, user, lark });
const out = JSON.stringify(cfg, null, 2) + "\n";
if (mode === "print") { process.stdout.write(out); process.exit(0); }
const tmp = file + ".tmp." + process.pid;
fs.writeFileSync(tmp, out, { mode: 0o600 });
fs.renameSync(tmp, file);
fs.chmodSync(file, 0o600);
'
PATCH_RULES='
const fs = require("fs");
const [file, owner, mode] = process.argv.slice(1);
const rules = JSON.parse(fs.readFileSync(file, "utf8"));
rules.channels = rules.channels && typeof rules.channels === "object" ? rules.channels : {};
const prev = rules.channels.feishu && typeof rules.channels.feishu === "object" ? rules.channels.feishu : {};
rules.channels.feishu = Object.assign({}, prev, { name: "审阅机器人", answerers: [owner] });
const out = JSON.stringify(rules, null, 2) + "\n";
if (mode === "print") { process.stdout.write(out); process.exit(0); }
const tmp = file + ".tmp." + process.pid;
fs.writeFileSync(tmp, out, { mode: 0o600 });
fs.renameSync(tmp, file);
'

step "5. patch config.json（channels.feishu）"
note "文件：$AUTOLOOP_CONFIG"
if is_dry; then
  if [ -f "$AUTOLOOP_CONFIG" ]; then
    info "[dry-run] config.json 改动预览（channels.feishu 这一段）："
    node -e "$PATCH_CONFIG" "$AUTOLOOP_CONFIG" "$CHANNEL_KEY" "$OWNER" "$WRAPPER" print \
      | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  const cfg = JSON.parse(raw);
  const ch = (cfg.channels && cfg.channels.feishu) || {};
  if (ch.key) ch.key = "<CHANNEL_KEY（已存在，预览不显示）>";
  process.stdout.write(JSON.stringify({ channels: { feishu: ch } }, null, 2) + "\n");
});
' | sed 's/^/    │ /'
  else
    info "[dry-run] config.json 不存在，跳过预览"
  fi
else
  backup_file "$AUTOLOOP_CONFIG"
  CFG_BACKUP="$LAST_BACKUP"
  [ -n "$CFG_BACKUP" ] || fail "config.json 备份失败，已停止（未改动任何文件）"
  ROLLBACK_ACTIVE=1
  node -e "$PATCH_CONFIG" "$AUTOLOOP_CONFIG" "$CHANNEL_KEY" "$OWNER" "$WRAPPER" write \
    || fail "写 config.json 失败"
  json_valid "$AUTOLOOP_CONFIG" || fail "写完后 config.json 不是合法 JSON"
  ok "已更新 config.json：channels.feishu { key: 已设置(长度 ${#CHANNEL_KEY}), user: $OWNER, lark: $WRAPPER }"
fi

step "6. patch rules.json（channels.feishu.name / answerers）"
note "文件：$AUTOLOOP_RULES"
if is_dry; then
  if [ -f "$AUTOLOOP_RULES" ]; then
    info "[dry-run] rules.json 改动预览（channels 这一段）："
    node -e "$PATCH_RULES" "$AUTOLOOP_RULES" "$OWNER" print \
      | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  const rules = JSON.parse(raw);
  process.stdout.write(JSON.stringify({ channels: rules.channels }, null, 2) + "\n");
});
' | sed 's/^/    │ /'
  else
    info "[dry-run] rules.json 不存在，跳过预览"
  fi
else
  backup_file "$AUTOLOOP_RULES"
  RULES_BACKUP="$LAST_BACKUP"
  [ -n "$RULES_BACKUP" ] || fail "rules.json 备份失败，已停止"
  ROLLBACK_ACTIVE=1
  node -e "$PATCH_RULES" "$AUTOLOOP_RULES" "$OWNER" write || fail "写 rules.json 失败"
  json_valid "$AUTOLOOP_RULES" || fail "写完后 rules.json 不是合法 JSON"
  ok "已更新 rules.json：channels.feishu { name: $CHANNEL_NAME, answerers: [$OWNER] }"
fi

step "7. 校验 autoloop 规则"
if is_dry; then
  info "[dry-run] 将执行：agent-autoloop check"
else
  if agent-autoloop check; then
    ok "rules.json 校验通过"
    ROLLBACK_ACTIVE=0
  else
    warn "agent-autoloop check 失败，回滚 config.json / rules.json"
    restore_backups
    ROLLBACK_ACTIVE=0
    warn_key_mismatch
    fail "已回滚到安装前状态。请按上面的报错修 rules.json（模板见 configs/autoloop/rules.example.json）后重跑"
  fi
fi

# ---------------------------------------------------------------- 8. 重启提示 + 验收
step "8. 重启中台，让新通道生效"
say "  config.json 只在 autoloop 启动时读取；改完必须重启一次："
say "    macOS（安装器注册了 launchd 系统服务）：launchctl kickstart -k gui/\$(id -u)/agent-autoloop"
say "    或重装/重启系统服务：agent-autoloop service install"
say "    没有系统服务（手动 agent-autoloop up）：停掉旧进程后重新 agent-autoloop up"
say ""
say "  验证：agent-autoloop status   →  通道里出现「${CHANNEL_NAME}」且在线"
say "  发一张测试卡：printf '审阅机器人通道自测\\n' | agent-autoloop tell tieka-feishu-test"
say "  点卡片按钮应能回传（需应用已订阅 card.action.trigger 长连接事件，见 docs/FEISHU-SETUP.md）"

step "摘要"
say "  OPEN_ID=$OWNER"
say "  profile       : ${PROFILE}（appId=${APP_ID:-（沿用已有 profile）}）"
say "  wrapper       : $WRAPPER"
say "  config.json   : $AUTOLOOP_CONFIG"
say "  rules.json    : $AUTOLOOP_RULES"
if [ -n "$CFG_BACKUP" ]; then
  say "  备份          : $CFG_BACKUP"
  if [ -n "$RULES_BACKUP" ]; then say "                  $RULES_BACKUP"; fi
fi
say ""
if is_dry; then
  say "（dry-run 结束：没有写任何文件、没有创建 profile、没有调用 agent-autoloop key new）"
fi
say "回滚：有备份就 cp 回去；或删 $WRAPPER 并把 config.json/rules.json 的 channels.feishu 换回旧值；"
say "      通道密钥可收回：agent-autoloop key remove channel feishu"
