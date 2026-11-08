#!/usr/bin/env bash
# 用模板生成 ~/.agent-autoloop/rules.json（DSH / Codex / Claude 三个 Agent + 四条示例规则）。
#
# - 只写 rules.json；不动 config.json、不装/不重启中台、不碰 DSH。
# - 写之前备份旧 rules.json；写之后跑 agent-autoloop check；检查失败自动回滚。
# - 支持 --dry-run：只把将写入的 JSON 打到 stdout（不碰磁盘）。
# - 参数替换见 configs/autoloop/rules.example.json 里的 {{…}} 占位符，说明见 rules.example.md。
#
# 用法：
#   bash bin/apply-autoloop-config.sh --owner-open-id ou_xxx [--worker 电脑名]
#        [--cwd-try ~/tieka-try] [--cwd-code ~/tieka-code] [--cwd-work ~/tieka-work]
#        [--no-feishu] [--dry-run]
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
KIT_DIR="$(cd "$SELF_DIR/.." && pwd)"
TEMPLATE="$KIT_DIR/configs/autoloop/rules.example.json"
AUTOLOOP_HOME="${AGENT_AUTOLOOP_HOME:-$HOME/.agent-autoloop}"
TARGET="${AGENT_AUTOLOOP_RULES:-$AUTOLOOP_HOME/rules.json}"
CONFIG="$AUTOLOOP_HOME/config.json"

OWNER=""
WORKER=""
CWD_TRY="~/tieka-try"
CWD_CODE="~/tieka-code"
CWD_WORK="~/tieka-work"
NO_FEISHU=0
DRY_RUN=0

usage() {
  cat <<'EOF'
用法：bash bin/apply-autoloop-config.sh --owner-open-id <飞书 open_id> [选项]

用模板生成 ~/.agent-autoloop/rules.json（已安装的 agent-autoloop 会自动生效）。

必填：
  --owner-open-id <open_id>  能回答卡片的本人 open_id（以 ou_ 开头）；先不接飞书可用 --no-feishu

可选：
  --worker <名字>            接单电脑名，必须和 config.json 的 worker.name 一致；
                             不传时先读 config.json，读不到再用 hostname
  --cwd-try <目录>           试跑规则的工作目录，默认 ~/tieka-try
  --cwd-code <目录>          代码任务规则的工作目录，默认 ~/tieka-code
  --cwd-work <目录>          简报/复盘规则的工作目录，默认 ~/tieka-work
  --no-feishu                生成时去掉飞书通道（之后接好再重新生成）
  --dry-run                  只把将写入的 JSON 打到 stdout，不碰磁盘
  -h, --help                 显示本帮助

环境变量：
  AGENT_AUTOLOOP_HOME        安装目录，默认 ~/.agent-autoloop
  AGENT_AUTOLOOP_RULES       规则文件路径，默认 <安装目录>/rules.json（主要给测试用）

示例：
  mkdir -p ~/tieka-try ~/tieka-code ~/tieka-work
  bash bin/apply-autoloop-config.sh --owner-open-id ou_xxxxxxxx
  bash bin/apply-autoloop-config.sh --owner-open-id ou_xxxxxxxx --dry-run | python3 -m json.tool
EOF
}

say() { if [ "$DRY_RUN" = 1 ]; then printf '%s\n' "$*" >&2; else printf '%s\n' "$*"; fi; }
step() { say ""; say "▸ $*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
fail() { printf '❌  %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 参数
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-feishu) NO_FEISHU=1; shift ;;
    --owner-open-id)
      [ $# -ge 2 ] || fail "--owner-open-id 需要一个值"
      OWNER="$2"; shift 2 ;;
    --worker)
      [ $# -ge 2 ] || fail "--worker 需要一个值"
      WORKER="$2"; shift 2 ;;
    --cwd-try)
      [ $# -ge 2 ] || fail "--cwd-try 需要一个目录"
      CWD_TRY="$2"; shift 2 ;;
    --cwd-code)
      [ $# -ge 2 ] || fail "--cwd-code 需要一个目录"
      CWD_CODE="$2"; shift 2 ;;
    --cwd-work)
      [ $# -ge 2 ] || fail "--cwd-work 需要一个目录"
      CWD_WORK="$2"; shift 2 ;;
    --owner-open-id=*)
      OWNER="${1#*=}"; shift ;;
    --worker=*)
      WORKER="${1#*=}"; shift ;;
    --cwd-try=*)
      CWD_TRY="${1#*=}"; shift ;;
    --cwd-code=*)
      CWD_CODE="${1#*=}"; shift ;;
    --cwd-work=*)
      CWD_WORK="${1#*=}"; shift ;;
    *)
      fail "不认识的参数：${1}（见 --help）" ;;
  esac
done

# ---------------------------------------------------------------- 预检
[ -f "$TEMPLATE" ] || fail "找不到模板：${TEMPLATE}（套件不完整？）"
command -v python3 >/dev/null 2>&1 || fail "需要 python3 生成规则。macOS：xcode-select --install；Linux：apt install python3。"

if [ "$NO_FEISHU" = 0 ]; then
  [ -n "$OWNER" ] || fail "缺少 --owner-open-id（飞书里能回答卡片的人的 open_id）。先不接飞书可加 --no-feishu。"
fi
if [ -n "$OWNER" ]; then
  case "$OWNER" in
    ou_*) ;;
    *) fail "--owner-open-id 看起来不是飞书 open_id：应以 ou_ 开头。可在飞书应用后台或 lark-cli 输出里找到。" ;;
  esac
  case "$OWNER" in
    *[!A-Za-z0-9_-]*|ou_) fail "--owner-open-id 格式不对：只应包含字母、数字、_ 和 -。" ;;
  esac
fi

# worker：参数 > config.json 的 worker.name > hostname（小写、只留 a-z0-9-）。
if [ -z "$WORKER" ]; then
  WORKER="$(python3 - "$CONFIG" <<'PY'
import json, re, socket, sys

path = sys.argv[1]
name = ""
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    name = ((data.get("worker") or {}).get("name") or "").strip()
except Exception:
    name = ""

if not name:
    host = socket.gethostname().split(".")[0].lower()
    name = re.sub(r"[^a-z0-9-]", "-", host)
    name = re.sub(r"-{2,}", "-", name).strip("-")
    if not re.match(r"^[a-z]", name or ""):
        name = "worker-" + (name or "this-machine")

print(name)
PY
)"
fi
case "$WORKER" in
  ''|*[!a-z0-9-]*) fail "--worker 名字不合法：${WORKER}（只能用 a-z、0-9 和 -，且以字母开头）" ;;
  [a-z]*) ;;
  *) fail "--worker 名字不合法：${WORKER}（要用小写字母开头）" ;;
esac

# cwd：必须是 ~/ 或绝对路径（agent-autoloop 的规则要求）；相对路径转绝对路径。
normalize_cwd() {
  local dir="$1"
  case "$dir" in
    "~"|"~/"*) printf '%s' "$dir" ;;
    /*) printf '%s' "$dir" ;;
    *) printf '%s/%s' "$(pwd)" "$dir" ;;
  esac
}
CWD_TRY="$(normalize_cwd "$CWD_TRY")"
CWD_CODE="$(normalize_cwd "$CWD_CODE")"
CWD_WORK="$(normalize_cwd "$CWD_WORK")"

# ---------------------------------------------------------------- 生成
GENERATED="$(python3 - "$TEMPLATE" "$WORKER" "$OWNER" "$CWD_TRY" "$CWD_CODE" "$CWD_WORK" "$NO_FEISHU" "$TARGET" <<'PY'
import json
import sys

template, worker, owner, cwd_try, cwd_code, cwd_work, no_feishu, existing_path = sys.argv[1:9]
with open(template, encoding="utf-8") as f:
    data = json.load(f)

mapping = {
    "{{WORKER}}": worker,
    "{{OWNER_OPEN_ID}}": owner,
    "{{CWD_TRY}}": cwd_try,
    "{{CWD_CODE}}": cwd_code,
    "{{CWD_WORK}}": cwd_work,
}


def walk(value):
    if isinstance(value, str):
        for placeholder, replacement in mapping.items():
            value = value.replace(placeholder, replacement)
        return value
    if isinstance(value, list):
        return [walk(item) for item in value]
    if isinstance(value, dict):
        return {key: walk(item) for key, item in value.items()}
    return value


data = walk(data)
if no_feishu == "1":
    channels = data.get("channels") or {}
    channels.pop("feishu", None)
    if channels:
        data["channels"] = channels
    else:
        data.pop("channels", None)
else:
    # 保留已有 rules.json 里飞书通道的显示名（比如飞书接入脚本改成的「审阅机器人」）。
    old_name = ""
    try:
        with open(existing_path, encoding="utf-8") as f:
            old = json.load(f)
        old_name = str(((old.get("channels") or {}).get("feishu") or {}).get("name") or "").strip()
    except Exception:
        old_name = ""
    if old_name and isinstance(data.get("channels"), dict) and isinstance(data["channels"].get("feishu"), dict):
        data["channels"]["feishu"]["name"] = old_name

text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
leftover = [line for line in text.splitlines() if "{{" in line or "}}" in line]
if leftover:
    sys.exit("模板里还有没替换的占位符：" + " | ".join(leftover[:3]))
sys.stdout.write(text)
PY
)" || fail "生成 rules.json 失败（模板或参数有问题，见上）。"

# 生成结果必须是合法 JSON。
printf '%s\n' "$GENERATED" | python3 -m json.tool >/dev/null || fail "生成的规则不是合法 JSON。"

say "将生成：$TARGET"
say "  worker：$WORKER"
if [ "$NO_FEISHU" = 0 ]; then say "  飞书 answerers：$OWNER"; fi
say "  cwd：try=$CWD_TRY code=$CWD_CODE work=$CWD_WORK"

# ---------------------------------------------------------------- dry-run
if [ "$DRY_RUN" = 1 ]; then
  printf '%s\n' "$GENERATED"
  exit 0
fi

# ---------------------------------------------------------------- 写入 + 备份
mkdir -p "$(dirname "$TARGET")"
TMP_FILE="$(mktemp "$(dirname "$TARGET")/rules.json.tmp.XXXXXX")"
cleanup() { rm -f "$TMP_FILE"; }
trap cleanup EXIT
printf '%s\n' "$GENERATED" >"$TMP_FILE"
chmod 600 "$TMP_FILE"

WROTE=0
BACKUP=""
if [ -f "$TARGET" ] && cmp -s "$TMP_FILE" "$TARGET"; then
  say "✅ 规则没有变化，跳过备份和写入。"
else
  if [ -f "$TARGET" ]; then
    BACKUP="$TARGET.bak-$(date +%Y%m%d-%H%M%S)"
    cp -p "$TARGET" "$BACKUP"
    say "📦 已备份旧规则：$BACKUP"
  fi
  mv "$TMP_FILE" "$TARGET"
  chmod 600 "$TARGET"
  WROTE=1
  say "✅ 已写入：$TARGET"
fi

# ---------------------------------------------------------------- check + 回滚
rollback() {
  if [ "$WROTE" = 0 ]; then
    # 这一轮根本没动 rules.json（内容和原来一样），失败时不能碰它。
    warn "本轮没有改动 rules.json，保持原样。"
  elif [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
    cp -p "$BACKUP" "$TARGET"
    warn "已回滚到备份：$BACKUP"
  else
    rm -f "$TARGET"
    warn "没有旧规则可回滚，已删除本次生成的 $TARGET"
  fi
}

step "校验规则"
if command -v agent-autoloop >/dev/null 2>&1; then
  set +e
  CHECK_OUT="$(AGENT_AUTOLOOP_HOME="$AUTOLOOP_HOME" AGENT_AUTOLOOP_RULES="$TARGET" agent-autoloop check 2>&1)"
  CHECK_CODE=$?
  set -e
  if [ "$CHECK_CODE" -ne 0 ]; then
    printf '%s\n' "$CHECK_OUT" >&2
    rollback
    if [ "$WROTE" = 0 ]; then
      fail "rules.json 没通过 agent-autoloop check（本轮没改动文件）。按上面的提示处理后重跑。"
    fi
    fail "rules.json 没通过 agent-autoloop check，已回滚。按上面的提示改好后重跑。"
  fi
  say "✅ $CHECK_OUT"
else
  warn "没找到 agent-autoloop，跳过 check（JSON 已校验）。装好后运行：agent-autoloop check"
fi

# ---------------------------------------------------------------- 通道提醒
if [ "$NO_FEISHU" = 0 ]; then
  MISSING_CHANNEL="$(python3 - "$TARGET" "$CONFIG" <<'PY'
import json, sys

rules_path, config_path = sys.argv[1], sys.argv[2]
try:
    with open(rules_path, encoding="utf-8") as f:
        rules = json.load(f)
except Exception:
    sys.exit(0)
if "feishu" not in (rules.get("channels") or {}):
    sys.exit(0)
try:
    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)
except Exception:
    print("no-config")
    raise SystemExit(0)
if "feishu" not in (config.get("channels") or {}):
    print("no-channel")
PY
)"
  case "$MISSING_CHANNEL" in
    no-config)
      warn "还没有 ${CONFIG}（中台未初始化？）。初始化后再运行本脚本，并确认飞书通道已接入。" ;;
    no-channel)
      warn "rules.json 里登记了飞书通道，但 config.json 里没有 feishu 通道密钥。"
      warn "先按 docs/ENVIRONMENT.md 接好飞书通道，再 agent-autoloop service install 让中台重读配置；"
      warn "暂时不接飞书可以加 --no-feishu 重新生成。" ;;
  esac
fi

# ---------------------------------------------------------------- 收尾
step "完成"
say "下一步："
say "  1. agent-autoloop status     # 看 worker/通道在线、规则加载"
say "  2. agent-autoloop try        # 真实调用模型，会消耗额度"
say "  3. 按 configs/autoloop/rules.example.md 改成自己的规则，改完 agent-autoloop check"
if [ -n "$BACKUP" ]; then say "  回滚：cp -p '$BACKUP' '$TARGET'"; fi
