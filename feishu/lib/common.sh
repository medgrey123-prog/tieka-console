#!/usr/bin/env bash
# tieka-console · 飞书机器人安装脚本共用函数
#
# 被 feishu/setup-task-bot.sh 和 feishu/setup-review-bot.sh source，不单独执行。
# 兼容 macOS 自带的 bash 3.2（不要用关联数组 / mapfile / ${var,,}）。
#
# 环境变量：
#   TIEKA_HOME               仅测试用：把「家目录」指向临时沙箱（脚本会同步 export HOME，
#                            这样 lark-cli profile、launchd plist、生成的配置都落在沙箱里）。
#   DSH_LARK_BOT_LABEL       覆盖任务发布机器人的 launchd label（默认 com.tieka.dsh-lark-bot）。
#   AGENT_AUTOLOOP_HOME      覆盖 autoloop 安装目录（默认 $HOME/.agent-autoloop）。
#   AGENT_AUTOLOOP_RULES     覆盖 rules.json 路径（默认 <AUTOLOOP_HOME>/rules.json，测试用）。
#
# 约定：
#   - 只写 $TARGET_HOME 下的文件；不 sudo、不装依赖、不重启服务。
#   - App Secret 只从 stdin（或终端无回显输入）读，绝不写进命令行/文件/日志。
#   - 失败时保持可回滚（setup-review-bot.sh 会恢复备份）。

# ---------------------------------------------------------------- 基础环境
DRY_RUN="${DRY_RUN:-0}"
TARGET_HOME="${TIEKA_HOME:-$HOME}"
SANDBOX="0"
if [ "$TARGET_HOME" != "$HOME" ]; then
  SANDBOX="1"
  export HOME="$TARGET_HOME"
fi

SELF_NAME="${SELF_NAME:-$(basename "${BASH_SOURCE[1]:-$0}")}"

# ---------------------------------------------------------------- 输出
say()  { printf '%s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*" >&2; }
info() { printf '  %s\n' "$*"; }
note() { printf '  ℹ️  %s\n' "$*"; }
fail() { printf '\n❌ %s\n' "$*" >&2; exit 1; }

is_dry() { [ "$DRY_RUN" = "1" ]; }
have()   { command -v "$1" >/dev/null 2>&1; }

fmt_cmd() {
  local out="" a
  for a in "$@"; do
    out="$out $(printf '%q' "$a")"
  done
  printf '%s' "${out# }"
}

show_cmd() { printf '  $ %s\n' "$(fmt_cmd "$@")"; }

run_cmd() {
  show_cmd "$@"
  is_dry && return 0
  "$@"
}

# ---------------------------------------------------------------- 通用小工具
require_node() {
  have node || fail "找不到 node。本套件需要 Node.js ≥ 20（推荐 24）：https://nodejs.org/ 或 brew install node@24"
  local major
  major="$(node -e 'process.stdout.write(String(Number(process.versions.node.split(".")[0])))' 2>/dev/null || echo 0)"
  case "$major" in ''|*[!0-9]*) major=0 ;; esac
  [ "$major" -ge 20 ] || fail "Node.js 版本太旧（$(node --version)），需要 ≥ 20"
}

# 把 stdin 写成文件；dry-run 时只打印内容，不落盘
write_file() { # $1=path $2=mode
  local path="$1" mode="${2:-600}"
  if is_dry; then
    printf '  [dry-run] 将写入 %s（chmod %s）：\n' "$path" "$mode"
    sed 's/^/    │ /'
    return 0
  fi
  local dir tmp
  dir="$(dirname "$path")"
  mkdir -p "$dir" || fail "建目录失败：$dir"
  tmp="${path}.tmp.$$"
  cat > "$tmp" || { rm -f "$tmp"; fail "写入失败：$path"; }
  chmod "$mode" "$tmp" 2>/dev/null || true
  mv "$tmp" "$path" || { rm -f "$tmp"; fail "保存失败：$path"; }
}

# 备份文件；结果放到 LAST_BACKUP（空 = 原文件不存在）
LAST_BACKUP=""
backup_file() { # $1=file
  LAST_BACKUP=""
  local f="$1" ts bak n
  [ -e "$f" ] || return 0
  ts="$(date +%Y%m%d-%H%M%S)"
  bak="${f}.bak-tieka-${ts}"
  n=1
  while [ -e "$bak" ]; do
    bak="${f}.bak-tieka-${ts}-${n}"
    n=$((n + 1))
  done
  if is_dry; then
    info "[dry-run] 将备份 $f → $bak"
    LAST_BACKUP="$bak"
    return 0
  fi
  cp -p "$f" "$bak" || fail "备份失败：$f"
  chmod 600 "$bak" 2>/dev/null || true
  LAST_BACKUP="$bak"
  ok "已备份 $f → $bak"
}

# ---------------------------------------------------------------- JSON（用 node，不依赖 jq/python）
json_get() { # $1=file $2=点分隔路径；打印标量，取不到打印空
  local file="$1" keypath="$2"
  [ -f "$file" ] || return 0
  node -e '
const fs = require("fs");
const [file, keypath] = process.argv.slice(1);
let data;
try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }
let v = data;
for (const part of keypath.split(".")) {
  if (v === null || typeof v !== "object" || !(part in v)) { v = undefined; break; }
  v = v[part];
}
if (v === undefined || v === null) process.exit(0);
process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
' "$file" "$keypath"
}

json_valid() { # $1=file
  [ -f "$1" ] || return 1
  node -e 'try { JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(1); }' "$1" >/dev/null 2>&1
}

# ---------------------------------------------------------------- App Secret
APP_SECRET=""
read_secret() {
  local s=""
  if [ -t 0 ]; then
    printf '  App Secret（粘贴后回车，输入不回显）：' >&2
    stty -echo 2>/dev/null || true
    IFS= read -r s || true
    stty echo 2>/dev/null || true
    printf '\n' >&2
  else
    IFS= read -r s || true
  fi
  s="$(printf '%s' "$s" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -n "$s" ] || fail "没有读到 App Secret（stdin 为空）。用法：printf '%s' '<APP_SECRET>' | bash $SELF_NAME --profile <name> --app-id <id>"
  APP_SECRET="$s"
}

# ---------------------------------------------------------------- lark-cli profile
LARK_CLI_BIN=""
require_lark_cli() {
  LARK_CLI_BIN="$(command -v lark-cli 2>/dev/null || true)"
  if [ -z "$LARK_CLI_BIN" ]; then
    if is_dry; then
      warn "本机没有 lark-cli（dry-run 继续；真装时先 npm i -g @larksuite/cli）"
      return 0
    fi
    fail "找不到 lark-cli。先安装：npm i -g @larksuite/cli（装完重开终端）"
  fi
  ok "lark-cli：$LARK_CLI_BIN"
}

profile_app_id() { # $1=profile name；打印已有 appId，没有打印空
  local profile="$1"
  { lark-cli profile list 2>/dev/null || true; } | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  const name = process.argv[1];
  let rows;
  try { rows = JSON.parse(raw); } catch { process.exit(0); }
  if (!Array.isArray(rows)) rows = rows.profiles || rows.items || [];
  const hit = rows.find((r) => r && r.name === name);
  if (hit && hit.appId) process.stdout.write(String(hit.appId));
});
' "$profile"
}

# 根据已有 profile / --app-id 决定 add | skip | rebuild；APP_ID 由调用方持有并可被补全
PROFILE_ACTION=""
plan_profile() { # $1=profile $2=force(0/1)
  local profile="$1" force="$2" existing=""
  PROFILE_ACTION="add"
  if have lark-cli; then
    existing="$(profile_app_id "$profile")"
  elif is_dry; then
    warn "dry-run：本机没有 lark-cli，跳过 profile 检查"
    PROFILE_ACTION="add"
    return 0
  else
    fail "找不到 lark-cli。先安装：npm i -g @larksuite/cli（装完重开终端）"
  fi

  if [ -n "$existing" ]; then
    if [ -z "$APP_ID" ]; then
      APP_ID="$existing"
      info "profile「${profile}」已存在（appId=${existing}），--app-id 可省略"
    fi
    if [ "$existing" = "$APP_ID" ]; then
      PROFILE_ACTION="skip"
      ok "lark-cli profile「${profile}」已存在且 appId 一致（${existing}），跳过创建"
    elif [ "$force" = "1" ]; then
      PROFILE_ACTION="rebuild"
      warn "lark-cli profile「${profile}」已存在但 appId 不同（$existing ≠ ${APP_ID}），将删除后重建"
    else
      fail "lark-cli profile「${profile}」已存在，但 appId 不同（$existing ≠ ${APP_ID}）。确认覆盖（会删除该 profile 的本地凭证）就加 --force-profile"
    fi
  elif [ -z "$APP_ID" ]; then
    fail "profile「${profile}」不存在，必须传 --app-id <APP_ID>"
  fi
}

apply_profile() { # 使用 PROFILE_ACTION / APP_ID；需要时读 Secret 并创建 profile
  case "$PROFILE_ACTION" in
    skip) return 0 ;;
    add|rebuild) ;;
    *) fail "内部错误：未知的 PROFILE_ACTION=$PROFILE_ACTION" ;;
  esac

  if is_dry; then
    if [ "$PROFILE_ACTION" = "rebuild" ]; then
      info "[dry-run] 将执行：lark-cli profile remove ${PROFILE}（若它是唯一 profile，会先建临时 profile 再删）"
    fi
    info "[dry-run] 将执行：printf '%s' '<APP_SECRET>' | lark-cli profile add --name $PROFILE --app-id ${APP_ID:-<APP_ID>} --app-secret-stdin --brand feishu"
    return 0
  fi

  read_secret
  TEMP_PROFILE_TO_CLEAN=""
  if [ "$PROFILE_ACTION" = "rebuild" ]; then
    show_cmd lark-cli profile remove "$PROFILE"
    REMOVE_RC=0
    REMOVE_OUT="$(lark-cli profile remove "$PROFILE" 2>&1)" || REMOVE_RC=$?
    if [ "$REMOVE_RC" -ne 0 ]; then
      case "$REMOVE_OUT" in
        *"only profile"*)
          # lark-cli 不允许删除最后一个 profile：先加一个临时 profile，删掉目标后再清理。
          warn "lark-cli 不允许删除唯一的 profile，先建一个临时 profile 再删"
          TEMP_PROFILE="tieka-tmp-$$-$(date +%s)"
          printf '%s\n' "placeholder-not-a-real-secret" \
            | lark-cli profile add --name "$TEMP_PROFILE" --app-id "cli_placeholder000000" --app-secret-stdin --brand feishu >/dev/null 2>&1 \
            || fail "创建临时 profile 失败，无法重建「${PROFILE}」。请手动：lark-cli profile list / lark-cli profile remove $PROFILE"
          lark-cli profile remove "$PROFILE" >/dev/null 2>&1 \
            || fail "删除 profile「${PROFILE}」失败（临时 profile 已建，可手动：lark-cli profile remove ${PROFILE}）"
          TEMP_PROFILE_TO_CLEAN="$TEMP_PROFILE"
          ;;
        *)
          fail "删除旧 profile「${PROFILE}」失败：$REMOVE_OUT"
          ;;
      esac
    fi
  fi

  info "创建 lark-cli profile「${PROFILE}」（App Secret 走 stdin，不落盘明文、不进历史）…"
  printf '%s\n' "$APP_SECRET" \
    | lark-cli profile add --name "$PROFILE" --app-id "$APP_ID" --app-secret-stdin --brand feishu \
    || fail "创建 lark-cli profile 失败：检查 App ID / App Secret 是否正确、网络是否可达 open.feishu.cn"
  APP_SECRET=""
  if [ -n "${TEMP_PROFILE_TO_CLEAN:-}" ]; then
    if lark-cli profile remove "$TEMP_PROFILE_TO_CLEAN" >/dev/null 2>&1; then
      info "已清理临时 profile「${TEMP_PROFILE_TO_CLEAN}」"
    else
      warn "临时 profile 未清理，可手动：lark-cli profile remove $TEMP_PROFILE_TO_CLEAN"
    fi
  fi
  ok "lark-cli profile「${PROFILE}」已就绪（brand=feishu）"
}

# 写「固定 profile 的 lark-cli wrapper」；bot 的 larkBin / autoloop 的 channels.feishu.lark 都指向它
write_lark_wrapper() { # $1=path $2=profile $3=用途说明
  local path="$1" profile="$2" purpose="$3" bin
  bin="$(command -v lark-cli 2>/dev/null || true)"
  [ -n "$bin" ] || bin="<LARK_CLI_ABS_PATH>"
  if is_dry && [ "$bin" = "<LARK_CLI_ABS_PATH>" ]; then
    warn "dry-run：本机没有 lark-cli，wrapper 里将用占位路径"
  fi
  info "wrapper 内固定 lark-cli：$bin"
  write_file "$path" 700 <<WRAPPER
#!/bin/sh
# 由 tieka-console/feishu/${SELF_NAME} 生成（$(date +%Y-%m-%d)），用途：${purpose}。
# 固定使用 lark-cli profile「${profile}」。重新安装请重跑脚本，不要手改本文件。
LARK_CLI="${bin}"
[ -x "\$LARK_CLI" ] || LARK_CLI="\$(command -v lark-cli 2>/dev/null || true)"
[ -n "\$LARK_CLI" ] || { echo "lark-cli not found; rerun feishu/${SELF_NAME}" >&2; exit 127; }
exec "\$LARK_CLI" --profile "${profile}" "\$@"
WRAPPER
  ok "wrapper：${path}（chmod 700）"
}

# ---------------------------------------------------------------- 参数校验
validate_profile_name() {
  local name="$1"
  [ -n "$name" ] || fail "--profile 不能为空"
  case "$name" in
    -*) fail "--profile 不能以 - 开头：$name" ;;
  esac
  case "$name" in
    *[!A-Za-z0-9._-]*) fail "--profile 只允许字母、数字、点、下划线、横线：$name" ;;
  esac
}

validate_app_id() {
  local id="$1"
  [ -n "$id" ] || return 0
  case "$id" in
    cli_*) ;;
    *) warn "--app-id 通常以 cli_ 开头（国内飞书应用 ID），确认没传错：$id" ;;
  esac
  case "$id" in
    *[!A-Za-z0-9_]*) fail "--app-id 只应包含字母、数字、下划线：$id" ;;
  esac
}

validate_owner() {
  local id="$1"
  [ -n "$id" ] || return 0
  case "$id" in
    ou_*) ;;
    *) fail "--owner 应该是飞书 open_id（ou_ 开头），收到：$id" ;;
  esac
  case "$id" in
    *[!A-Za-z0-9_-]*) fail "--owner 格式不对，只应包含字母、数字、_ 和 -：$id" ;;
  esac
}

# 打印运行环境头（每个脚本安装开始时调用一次）
print_banner() { # $1=标题
  say ""
  say "════════════════════════════════════════════════════════════"
  say "  $1"
  say "════════════════════════════════════════════════════════════"
  info "家目录：$TARGET_HOME"
  if [ "$SANDBOX" = "1" ]; then
    warn "TIEKA_HOME 沙箱模式：所有文件只会写进 ${TARGET_HOME}（仅测试用，正式安装请 unset TIEKA_HOME）"
  fi
  if is_dry; then
    info "模式：--dry-run（只打印计划，不写文件、不执行安装/登录命令）"
  fi
}
