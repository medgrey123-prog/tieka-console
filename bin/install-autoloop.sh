#!/usr/bin/env bash
# 安装 agent-autoloop（上游开源项目），或检查本机已有的安装是否可用。
#
# - 从上游安装：https://github.com/KKKKhazix/agent-autoloop （MIT，Node ≥ 24，零依赖）
# - 幂等：已经装好就只打印版本并跳过；要升级用 --update。
# - 默认行为与上游 install.sh 一致（会装系统服务让它常驻）；想手动管理加 --no-service。
#
# 用法：
#   bash bin/install-autoloop.sh [--no-service] [--agent claude|codex] [--command '命令 {prompt}']
#                                [--port 3350] [--update] [--dry-run] [--help]
#
# 环境变量：
#   AGENT_AUTOLOOP_REPO          git 仓库地址，或本地仓库目录（离线/内网安装）
#   AGENT_AUTOLOOP_HOME          安装目录，默认 ~/.agent-autoloop
#   AGENT_AUTOLOOP_INSTALL_URL   远程 install.sh 地址，默认上游 main 分支
#
# 本脚本不写任何密钥，也不改 DSH；装完用 bin/apply-autoloop-config.sh 生成规则。
set -euo pipefail

REPO="${AGENT_AUTOLOOP_REPO:-https://github.com/KKKKhazix/agent-autoloop}"
INSTALL_URL="${AGENT_AUTOLOOP_INSTALL_URL:-https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh}"
HOME_DIR="${AGENT_AUTOLOOP_HOME:-$HOME/.agent-autoloop}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
KIT_DIR="$(cd "$SELF_DIR/.." && pwd)"

DRY_RUN=0
UPDATE=0
PASSTHROUGH=()

usage() {
  cat <<'EOF'
用法：bash bin/install-autoloop.sh [选项]

从上游安装 agent-autoloop（或者检查已有安装）。可重复执行，幂等。

选项：
  --no-service             不装系统服务（之后自己 agent-autoloop up 启动）
  --agent claude|codex     首次安装时用哪种 Agent 初始化（透传给上游 install.sh）
  --command '命令 {prompt}' 首次安装时用自定义命令行 Agent（例如 DSH）
  --port <端口>            中台端口，默认 3350（透传）
  --update                 已安装时执行 agent-autoloop update 升级
  --dry-run                只打印将执行的命令，不安装、不改本机
  -h, --help               显示本帮助

环境变量：
  AGENT_AUTOLOOP_REPO         git 仓库地址或本地仓库目录（离线/内网）
  AGENT_AUTOLOOP_HOME         安装目录，默认 ~/.agent-autoloop
  AGENT_AUTOLOOP_INSTALL_URL  远程 install.sh 地址

装完后下一步：
  mkdir -p ~/tieka-try ~/tieka-code ~/tieka-work
  bash bin/apply-autoloop-config.sh --owner-open-id <飞书 open_id>
  agent-autoloop check && agent-autoloop status
  agent-autoloop try        # 注意：会真实调用模型，消耗额度

Windows 不支持；macOS / Linux（含 WSL）可用。
EOF
}

say() { printf '%s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
fail() { printf '❌  %s\n' "$*" >&2; exit 1; }

node_hint() {
  cat >&2 <<'EOF'
需要 Node.js 24 或更新。安装方式（二选一，装完重开终端）：
  Homebrew： brew install node@24
             然后在 ~/.zshrc（bash 用 ~/.bashrc）追加：
             export PATH="$(brew --prefix node@24)/bin:$PATH"
  nvm：      nvm install 24 && nvm alias default 24 && nvm use 24
验证：node -v
注意：DSH 桌面版自带的 Node 只给 DSH 自己用，不算命令行 Node；autoloop 需要 PATH 上的 node。
EOF
}

# ---------------------------------------------------------------- 参数
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --update) UPDATE=1; shift ;;
    --no-service) PASSTHROUGH+=("--no-service"); shift ;;
    --agent|--command|--port)
      [ $# -ge 2 ] || fail "$1 需要一个值"
      PASSTHROUGH+=("$1" "$2"); shift 2 ;;
    --agent=*|--command=*|--port=*)
      # 上游只认「--flag 值」形式，这里拆开再传。
      PASSTHROUGH+=("${1%%=*}" "${1#*=}"); shift ;;
    *)
      fail "不认识的参数：${1}（见 --help）" ;;
  esac
done

has_init_agent_flag() {
  local item
  for item in ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}; do
    case "$item" in
      --agent|--command) return 0 ;;
    esac
  done
  return 1
}

# ---------------------------------------------------------------- 环境
check_platform() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin|Linux) ;;
    *) fail "本套件只支持 macOS / Linux（WSL 里的 Linux 可以）。Windows 原生不支持，见 docs/ENVIRONMENT.md 的替代建议。" ;;
  esac
}

check_node() {
  command -v node >/dev/null 2>&1 || { printf '❌ 没找到 node。\n' >&2; node_hint; exit 1; }
  local major
  major="$(node -e 'process.stdout.write(String(Number(process.versions.node.split(".")[0])))' 2>/dev/null || echo 0)"
  case "$major" in
    ''|*[!0-9]*) fail "读不到 Node 版本：$(node -v 2>/dev/null || echo '?')" ;;
  esac
  if [ "$major" -lt 24 ]; then
    printf '❌ Node 版本过低：%s（需要 24 或更新）\n' "$(node -v)" >&2
    node_hint
    exit 1
  fi
  say "✅ Node $(node -v)"
}

AUTOLOOP_BIN=""
resolve_autoloop() {
  AUTOLOOP_BIN=""
  if command -v agent-autoloop >/dev/null 2>&1; then
    AUTOLOOP_BIN="$(command -v agent-autoloop)"
  fi
}

installed() {
  resolve_autoloop
  [ -n "$AUTOLOOP_BIN" ] || [ -f "$HOME_DIR/app/bin/agent-autoloop.ts" ]
}

# 统一入口：PATH 上有就用；否则用安装目录里的程序文件（PATH 没配好也能跑）。
run_autoloop() {
  resolve_autoloop
  if [ -n "$AUTOLOOP_BIN" ]; then
    "$AUTOLOOP_BIN" "$@"
  elif [ -f "$HOME_DIR/app/bin/agent-autoloop.ts" ]; then
    node --disable-warning=ExperimentalWarning "$HOME_DIR/app/bin/agent-autoloop.ts" "$@"
  else
    return 127
  fi
}

autoloop_version() {
  run_autoloop --version 2>/dev/null | head -n 1 || true
}

path_hint() {
  resolve_autoloop
  if [ -z "$AUTOLOOP_BIN" ] && [ -f "$HOME_DIR/app/bin/agent-autoloop.ts" ]; then
    warn "程序已装，但 PATH 上找不到 agent-autoloop。把下面一行加进 ~/.zshrc（bash 用 ~/.bashrc）后重开终端："
    printf '     alias agent-autoloop="node --disable-warning=ExperimentalWarning %s/app/bin/agent-autoloop.ts"\n' "$HOME_DIR" >&2
  fi
}

next_steps() {
  cat <<EOF

下一步：
  1. mkdir -p ~/tieka-try ~/tieka-code ~/tieka-work
  2. bash "$KIT_DIR/bin/apply-autoloop-config.sh" --owner-open-id <飞书 open_id>
  3. agent-autoloop check && agent-autoloop status
  4. agent-autoloop try     # 注意：会真实调用模型，消耗额度

提示：接飞书通道见 docs/ENVIRONMENT.md 和 configs/autoloop/rules.example.md。
EOF
}

# ---------------------------------------------------------------- 安装动作
install_script() {
  # 远程：先下载到临时文件；本地仓库：直接用仓库里的 install.sh。
  if [ -d "$REPO" ]; then
    [ -f "$REPO/install.sh" ] || fail "本地仓库里没有 install.sh：$REPO"
    say "使用本地仓库：$REPO"
    run_installer "$REPO/install.sh"
    return
  fi
  command -v curl >/dev/null 2>&1 || fail "没找到 curl。macOS 自带；Linux：apt install curl / dnf install curl。"
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/autoloop-install.XXXXXX")"
  say "下载安装脚本：$INSTALL_URL"
  if ! curl -fsSL "$INSTALL_URL" -o "$tmp"; then
    rm -f "$tmp"
    fail "下载 install.sh 失败：检查网络或 AGENT_AUTOLOOP_INSTALL_URL"
  fi
  set +e
  run_installer "$tmp"
  local code=$?
  set -e
  rm -f "$tmp"
  [ "$code" -eq 0 ] || exit "$code"
}

run_installer() {
  local script="$1"
  local args=()
  if [ "${#PASSTHROUGH[@]}" -gt 0 ]; then
    args+=("${PASSTHROUGH[@]}")
  fi
  if [ "${#INIT_ARGS[@]}" -gt 0 ]; then
    args+=("${INIT_ARGS[@]}")
  fi
  if [ "${#args[@]}" -gt 0 ]; then
    AGENT_AUTOLOOP_REPO="$REPO" sh "$script" "${args[@]}"
  else
    AGENT_AUTOLOOP_REPO="$REPO" sh "$script"
  fi
}

# ---------------------------------------------------------------- 主流程
INIT_ARGS=()

say "agent-autoloop 安装器（上游：https://github.com/KKKKhazix/agent-autoloop）"
say "安装目录：$HOME_DIR"
if [ "$DRY_RUN" = 1 ]; then say "（--dry-run：只打印将执行的命令，不安装、不改本机）"; fi

step "检查平台与 Node"
check_platform
check_node

step "检查已有安装"
if installed; then
  say "✅ 已安装：$(autoloop_version || true)"
  path_hint
  if [ "$UPDATE" = 1 ]; then
    step "升级 agent-autoloop"
    if [ "$DRY_RUN" = 1 ]; then
      say "  + agent-autoloop update"
    else
      run_autoloop update || fail "升级失败（agent-autoloop update 返回非 0）。原安装没删，可重试；网络/权限见 docs/ENVIRONMENT.md。"
      say "✅ 已升级：$(autoloop_version || true)"
    fi
  else
    say "跳过安装（幂等）。要升级就加 --update。"
  fi
  next_steps
  exit 0
fi

say "尚未安装。"

step "准备首次安装"
command -v git >/dev/null 2>&1 || fail "没找到 git。macOS：xcode-select --install；Linux：apt install git / dnf install git。"
say "✅ $(git --version 2>/dev/null | head -n 1)"

# 上游 init 需要至少一种 Agent：claude / codex / --command。只有 DSH 时自动用 DSH 初始化。
if ! has_init_agent_flag; then
  if command -v claude >/dev/null 2>&1 || command -v codex >/dev/null 2>&1; then
    : # 让上游 init 自动探测
  elif command -v dsh >/dev/null 2>&1; then
    INIT_ARGS=(--command "dsh --profile headless {prompt}")
    say "ℹ️  没找到 claude / codex，用 DSH 初始化中台：--command 'dsh --profile headless {prompt}'"
  else
    fail "没找到可用的 Agent（claude / codex / dsh）。先装其中一个并登录（见 docs/ENVIRONMENT.md），或用 --command '某个命令 {prompt}' 指定。"
  fi
fi

if [ "$DRY_RUN" = 1 ]; then
  step "（dry-run）将执行"
  if [ -d "$REPO" ]; then
    printf '  + AGENT_AUTOLOOP_REPO=%q sh %q/install.sh %s %s\n' \
      "$REPO" "$REPO" "${PASSTHROUGH[*]-}" "${INIT_ARGS[*]-}"
  else
    say "  + curl -fsSL $INSTALL_URL -o <临时文件>"
    printf '  + AGENT_AUTOLOOP_REPO=%q sh <临时文件> %s %s\n' \
      "$REPO" "${PASSTHROUGH[*]-}" "${INIT_ARGS[*]-}"
  fi
  say "  + agent-autoloop --version"
  next_steps
  exit 0
fi

step "从上游安装（首次；需要外网和 git）"
install_script

step "验证安装"
if installed; then
  say "✅ agent-autoloop：$(autoloop_version || echo '（读不到版本）')"
  path_hint
else
  warn "安装脚本执行完了，但找不到 agent-autoloop。可能是 PATH 上没有可写目录。"
  warn "程序通常在 $HOME_DIR/app/bin/agent-autoloop.ts，可用完整路径运行；或按上面的 alias 提示配置后重开终端。"
fi

next_steps
say ""
say "注意：agent-autoloop try 和定时规则都会真实调用模型，消耗额度。"
