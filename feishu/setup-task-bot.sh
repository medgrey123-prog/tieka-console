#!/usr/bin/env bash
# tieka-console · 任务发布机器人（dsh-lark-bot）安装脚本
#
# 做四件事（全部幂等，可重复运行）：
#   1) 在 lark-cli 里创建/复用固定飞书应用的 profile（App Secret 从 stdin 或终端无回显读）
#   2) 写 wrapper：$HOME/.dsh-lark-bot/lark-feishu-task.sh（固定 profile 的 lark-cli 入口）
#   3) 生成 $HOME/.dsh-lark-bot/config.json（基于 bots/dsh-lark-bot/config.example.json）
#   4) 安装并启动 launchd 常驻（--no-service 可跳过）
#
# 不做：不 sudo、不装依赖、不重启本机其它服务、不动别的 lark-cli profile。
#
# 用法见 --help；两阶段白名单引导见脚本末尾输出。
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
WORKDIR=""
NO_SERVICE=0
FORCE_PROFILE=0
DRY_RUN="${DRY_RUN:-0}"

usage() {
  cat <<'EOF'
用法：bash feishu/setup-task-bot.sh --profile <name> [--app-id <id>] [--owner <open_id>] [选项]

把「任务发布机器人」（dsh-lark-bot）接到本机：建 lark-cli profile → 写 wrapper →
生成 ~/.dsh-lark-bot/config.json → 安装并启动 launchd。

必填：
  --profile <name>      lark-cli profile 名（建议 tieka-task）
  --app-id <id>         飞书应用 App ID（cli_ 开头）；profile 已存在时可省略

可选：
  --owner <open_id>     主人 open_id（ou_ 开头）。第一次不知道就先不传，按末尾提示操作
  --workdir <dir>       任务默认工作目录（默认 ${HOME}；建议改成真正干活的目录）
  --no-service          只写文件，不安装/启动 launchd
  --force-profile       profile 同名但 App ID 不同时，删除旧 profile 后重建
  --dry-run             只打印计划：不写文件、不建 profile、不装 launchd
  -h, --help            显示本帮助

App Secret 传法（二选一，不要贴在命令行参数里）：
  printf '%s' "$SECRET" | bash feishu/setup-task-bot.sh --profile tieka-task --app-id cli_xxx
  直接运行脚本，按提示粘贴（输入不回显）

两阶段白名单引导：
  第 1 次不带 --owner；去飞书给「任务发布机器人」发一句话，它会回复你的 open_id；
  第 2 次（无需再传 Secret）：
  bash feishu/setup-task-bot.sh --profile tieka-task --owner ou_xxxxxxxxxxxxxxxx

环境变量：
  TIEKA_HOME             仅测试用：把文件写进临时沙箱（同时覆盖 HOME）
  DSH_LARK_BOT_LABEL     覆盖 launchd label（默认 com.tieka.dsh-lark-bot）
EOF
}

# ---------------------------------------------------------------- 参数
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-service) NO_SERVICE=1; shift ;;
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
    --workdir)
      [ $# -ge 2 ] || fail "--workdir 需要一个目录"
      WORKDIR="$2"; shift 2 ;;
    --workdir=*) WORKDIR="${1#*=}"; shift ;;
    *) fail "不认识的参数：${1}（bash $SELF_NAME --help 查看用法）" ;;
  esac
done

print_banner "任务发布机器人（dsh-lark-bot）安装"

# ---------------------------------------------------------------- 0. 预检
step "0. 检查输入与环境"
[ -n "$PROFILE" ] || fail "缺少 --profile（bash $SELF_NAME --help 查看用法）"
validate_profile_name "$PROFILE"
validate_app_id "$APP_ID"
validate_owner "$OWNER"
require_node
require_lark_cli

TEMPLATE="$KIT_DIR/bots/dsh-lark-bot/config.example.json"
BOT_DIR="$KIT_DIR/bots/dsh-lark-bot"
BOTCTL="$BOT_DIR/botctl.sh"
[ -f "$TEMPLATE" ] || fail "找不到配置模板：${TEMPLATE}（套件不完整）"
[ -f "$BOT_DIR/bot.mjs" ] || fail "找不到 $BOT_DIR/bot.mjs（套件不完整）"
[ -f "$BOTCTL" ] || fail "找不到 ${BOTCTL}（套件不完整）"

BOT_ROOT="$TARGET_HOME/.dsh-lark-bot"
WRAPPER="$BOT_ROOT/lark-feishu-task.sh"
CONFIG_PATH="$BOT_ROOT/config.json"
LEGACY_CONFIG="$BOT_DIR/config.json"
LABEL="${DSH_LARK_BOT_LABEL:-com.tieka.dsh-lark-bot}"

ok "profile：$PROFILE"
ok "套件：$KIT_DIR"
ok "安装位置：$BOT_ROOT"

if [ -n "$WORKDIR" ]; then
  case "$WORKDIR" in
    "~") WORKDIR="$TARGET_HOME" ;;
    "~/"*) WORKDIR="$TARGET_HOME/${WORKDIR#\~/}" ;;
  esac
  if [ -d "$WORKDIR" ]; then
    ok "workdir：$WORKDIR"
  elif is_dry; then
    warn "workdir 不存在（dry-run 继续）：$WORKDIR"
  else
    fail "workdir 不存在：${WORKDIR}（先 mkdir -p，或去掉 --workdir 用默认 \${HOME}）"
  fi
fi

# ---------------------------------------------------------------- 1. profile
step "1. lark-cli profile"
plan_profile "$PROFILE" "$FORCE_PROFILE"
apply_profile

# ---------------------------------------------------------------- 2. wrapper
step "2. lark-cli wrapper（bot 的 larkBin 指向它）"
write_lark_wrapper "$WRAPPER" "$PROFILE" "任务发布机器人"

# ---------------------------------------------------------------- 3. config.json
step "3. 机器人配置"
note "来源：${TEMPLATE}（展开 \$HOME 生成；重复运行保留已有字段）"

RENDER_CONFIG='
const fs = require("fs");
const [tplPath, existingPath, legacyPath, home, wrapper, owner, workdir] = process.argv.slice(1);
const expand = (v) => {
  if (typeof v === "string") return v.split("$HOME").join(home);
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = expand(v[k]);
    return o;
  }
  return v;
};
const loadJson = (p) => {
  if (!p || p === "-") return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
};
let cfg = expand(JSON.parse(fs.readFileSync(tplPath, "utf8")));
const legacy = loadJson(legacyPath);
const existing = loadJson(existingPath);
if (legacy) cfg = Object.assign({}, cfg, legacy);
if (existing) cfg = Object.assign({}, cfg, existing);
cfg.larkBin = wrapper;
if (owner) { cfg.ownerOpenId = owner; cfg.allowedUsers = [owner]; }
if (workdir) cfg.workdir = workdir;
if (!cfg.workdir || typeof cfg.workdir !== "string" || !fs.existsSync(cfg.workdir)) cfg.workdir = home;
process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
'

if is_dry; then
  info "[dry-run] 将写入 ${CONFIG_PATH}（chmod 600），内容预览："
  node -e "$RENDER_CONFIG" "$TEMPLATE" "$CONFIG_PATH" "$LEGACY_CONFIG" "$TARGET_HOME" "$WRAPPER" "$OWNER" "$WORKDIR" \
    | sed 's/^/    │ /'
  info "[dry-run] 并确保目录存在：$BOT_ROOT"
else
  mkdir -p "$BOT_ROOT"
  TMP_JSON="$(mktemp "${TMPDIR:-/tmp}/tieka-task-config.XXXXXX")"
  node -e "$RENDER_CONFIG" "$TEMPLATE" "$CONFIG_PATH" "$LEGACY_CONFIG" "$TARGET_HOME" "$WRAPPER" "$OWNER" "$WORKDIR" > "$TMP_JSON" \
    || { rm -f "$TMP_JSON"; fail "生成配置失败"; }
  if [ -f "$CONFIG_PATH" ] && cmp -s "$TMP_JSON" "$CONFIG_PATH"; then
    ok "配置无变化，跳过写入：$CONFIG_PATH"
    rm -f "$TMP_JSON"
  else
    backup_file "$CONFIG_PATH"
    cp "$TMP_JSON" "$CONFIG_PATH" || { rm -f "$TMP_JSON"; fail "写入配置失败：$CONFIG_PATH"; }
    chmod 600 "$CONFIG_PATH" 2>/dev/null || true
    rm -f "$TMP_JSON"
    ok "已写入 ${CONFIG_PATH}（chmod 600）"
  fi
  json_valid "$CONFIG_PATH" || fail "配置不是合法 JSON：$CONFIG_PATH"
  ok "配置 JSON 校验通过"
  if [ -e "$LEGACY_CONFIG" ]; then
    warn "发现旧布局配置 ${LEGACY_CONFIG}；现在生效的是 ${CONFIG_PATH}（优先级更高），旧文件可删"
  fi
  if [ -n "$(json_get "$CONFIG_PATH" ownerOpenId)" ]; then
    ok "白名单：$(json_get "$CONFIG_PATH" ownerOpenId)"
  else
    warn "ownerOpenId / allowedUsers 还是空的：装完按下面第 5 步去飞书拿 open_id 再补"
  fi
  if [ "$(json_get "$CONFIG_PATH" larkBin)" != "$WRAPPER" ]; then
    fail "配置里的 larkBin 不是 wrapper（$(json_get "$CONFIG_PATH" larkBin)），请检查生成逻辑"
  fi
fi

# ---------------------------------------------------------------- 4. launchd
step "4. launchd 常驻（开机自启）"
if [ "$NO_SERVICE" = "1" ]; then
  info "已指定 --no-service：不安装 launchd"
  info "手动启动：cd \"$KIT_DIR\" && bash bots/dsh-lark-bot/botctl.sh install"
elif is_dry; then
  info "[dry-run] 将执行：bash bots/dsh-lark-bot/botctl.sh install"
  info "[dry-run]   launchd label：$LABEL"
  info "[dry-run]   plist：$TARGET_HOME/Library/LaunchAgents/$LABEL.plist"
else
  info "launchd label：$LABEL"
  info "plist：$TARGET_HOME/Library/LaunchAgents/$LABEL.plist"
  bash "$BOTCTL" install || fail "launchd 安装失败：看 $BOT_ROOT/logs/launchd.err.log，或手动运行 bash bots/dsh-lark-bot/botctl.sh status"
  ok "launchd 已安装并启动"
fi

# ---------------------------------------------------------------- 5. 下一步
step "5. 下一步"
if [ -z "$OWNER" ]; then
  say ""
  say "⚠️  还差最后一步：把你加进白名单（第一次安装没有 --owner）"
  info "1) 在飞书里给「任务发布机器人」发任意一句话（例如：你好）"
  info "2) 它会回复「⛔ 未授权」并带上你的 open_id（ou_ 开头）"
  info "   —— 也可以看日志：$BOT_ROOT/logs/bot-*.log 里的「忽略未授权发送者 ou_...」"
  info "3) 用这个 open_id 重跑（不用再传 App Secret）："
  say ""
  say "   bash feishu/setup-task-bot.sh --profile $PROFILE --owner <你的OPEN_ID>"
  say ""
else
  ok "白名单已设置：$OWNER"
  info "验收："
  info "  bash bots/dsh-lark-bot/botctl.sh status"
  info "  bash bots/dsh-lark-bot/botctl.sh doctor"
  info "在飞书发「/ping」应回 pong；发「回我一句安装成功」应真的执行并回复"
fi
say ""
if is_dry; then
  say "（dry-run 结束：没有写任何文件、没有创建 profile、没有安装 launchd）"
fi
say "配置：${CONFIG_PATH}（改完 bash bots/dsh-lark-bot/botctl.sh restart 生效）"
say "日志：$BOT_ROOT/logs/"
say "卸载：bash bots/dsh-lark-bot/botctl.sh uninstall"
