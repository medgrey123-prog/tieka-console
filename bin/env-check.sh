#!/usr/bin/env bash
# 环境自检：这台电脑能不能装、能不能跑 agent-autoloop + DSH/Codex/Claude + 飞书通道。
#
# 输出逐项 ✅ / ❌ / ⚠️，每项带修复建议。
# 退出码：0 = 没有硬性项缺失（⚠️ 不影响继续）；1 = 有硬性项缺失（❌），装下去会卡住。
#
# 用法：bash bin/env-check.sh
#
# 只读检查，不改任何东西、不装任何东西、不联网发请求（只做一次 HTTPS 连通性探测）。
set -u

HARD_FAIL=0

ok() { printf '✅ %s\n' "$*"; }
bad() { printf '❌ %s\n' "$*"; HARD_FAIL=1; }
soft() { printf '⚠️  %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
fix() { printf '   ↳ 修复：%s\n' "$*"; }
section() { printf '\n── %s ──\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }
first_line() { head -n 1 2>/dev/null; }

# ---------------------------------------------------------------- 系统
section "系统"
OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"
case "$OS" in
  Darwin) ok "macOS（$(sw_vers -productVersion 2>/dev/null || echo '版本未知')，${ARCH}）" ;;
  Linux)
    if grep -qi microsoft /proc/version 2>/dev/null; then
      ok "Linux / WSL（${ARCH}）"
    else
      ok "Linux（${ARCH}）"
    fi
    ;;
  *)
    bad "不支持的系统：$OS"
    fix "本套件只支持 macOS / Linux。Windows 请在 WSL2 Ubuntu 里运行；或者用一台 Mac/Linux 电脑做中控台，业务机器只负责跑任务。"
    ;;
esac
if [ -n "${BASH_VERSION:-}" ]; then
  ok "bash ${BASH_VERSION}"
else
  bad "不是 bash 在跑这个脚本"
  fix "用 bash bin/env-check.sh 执行（本套件脚本都是 bash）。"
fi

# ---------------------------------------------------------------- 硬性依赖
section "硬性依赖（缺了装不下去）"
if have node; then
  NODE_VERSION="$(node -v 2>/dev/null || echo '?')"
  NODE_MAJOR="$(node -e 'process.stdout.write(String(Number(process.versions.node.split(".")[0])))' 2>/dev/null || echo 0)"
  case "$NODE_MAJOR" in
    ''|*[!0-9]*) NODE_MAJOR=0 ;;
  esac
  if [ "$NODE_MAJOR" -ge 24 ]; then
    ok "Node ${NODE_VERSION}（命令：$(command -v node)）"
  else
    bad "Node $NODE_VERSION 太旧，agent-autoloop 需要 Node ≥ 24"
    fix "Homebrew：brew install node@24；nvm：nvm install 24 && nvm alias default 24。装完重开终端，确认 node -v ≥ v24。"
  fi
else
  bad "没找到 node（命令行 Node）"
  fix "Homebrew：brew install node@24；nvm：nvm install 24。装完重开终端。"
  info "注意：DSH 桌面版自带的 Node runtime 只给 DSH 自己用，不算命令行 Node；autoloop 和本套件脚本要 PATH 上的 node。"
fi

if have git; then
  ok "git $(git --version 2>/dev/null | first_line)"
else
  bad "没找到 git"
  fix "macOS：xcode-select --install；Debian/Ubuntu：sudo apt install git；Fedora：sudo dnf install git。"
fi

if have curl; then
  ok "curl $(curl --version 2>/dev/null | first_line)"
else
  bad "没找到 curl"
  fix "macOS 自带；Debian/Ubuntu：sudo apt install curl；Fedora：sudo dnf install curl。"
fi

# ---------------------------------------------------------------- 推荐依赖
section "推荐依赖（可选，影响部分功能）"
if have python3; then
  ok "python3 $(python3 --version 2>/dev/null | head -n 1)"
else
  soft "没找到 python3（bin/apply-autoloop-config.sh 用它生成 rules.json）"
  fix "macOS：xcode-select --install 提供 python3；Debian/Ubuntu：sudo apt install python3。没装的话也可以手写 ~/.agent-autoloop/rules.json（见 configs/autoloop/rules.example.json）。"
fi

# ---------------------------------------------------------------- Agent
section "Agent（至少装一个、登录一个）"
DSH_OK=0
CLAUDE_OK=0
CODEX_OK=0

if have dsh; then
  DSH_VERSION="$(dsh --version 2>/dev/null | first_line)"
  ok "dsh ${DSH_VERSION:-（读不到版本）}（命令：$(command -v dsh)）"
  DSH_OK=1
  info "DSH 的 headless profile 是规则里 dsh Agent 的入口；确保 DSH 桌面版已登录并在运行。"
else
  soft "没找到 dsh CLI（DSH 桌面版可能没把命令行工具装进 PATH）"
  fix "装好并打开 DSH 桌面版，确认终端里 dsh --version 能输出版本；找不到就按 DSH 安装说明把它的 bin 目录加进 PATH。只打算用 Codex/Claude 的话可以不装。"
fi

if have claude; then
  CLAUDE_VERSION="$(claude --version 2>/dev/null | first_line)"
  ok "claude ${CLAUDE_VERSION:-（读不到版本）}（命令：$(command -v claude)）"
  CLAUDE_OK=1
  info "首次使用先运行 claude 完成登录（claude auth status 可查看登录状态）。"
else
  soft "没找到 Claude Code CLI"
  fix "npm i -g @anthropic-ai/claude-code（或按官方安装包），装完运行 claude 登录。只打算用 DSH/Codex 可以先跳过。"
fi

if have codex; then
  CODEX_VERSION="$(codex --version 2>/dev/null | first_line)"
  ok "codex ${CODEX_VERSION:-（读不到版本）}（命令：$(command -v codex)）"
  CODEX_OK=1
  info "首次使用先运行 codex login 完成登录。"
else
  soft "没找到 Codex CLI"
  fix "npm i -g @openai/codex，装完运行 codex login。只打算用 DSH/Claude 可以先跳过。"
fi

if [ "$DSH_OK" = 0 ] && [ "$CLAUDE_OK" = 0 ] && [ "$CODEX_OK" = 0 ]; then
  bad "dsh / claude / codex 一个都没有：规则无法派活"
  fix "至少装一个并登录；推荐三个都装（DSH 跑定时任务、Codex 只读排障、Claude 做编辑类整理）。"
fi

# ---------------------------------------------------------------- 飞书 / GitHub
section "通知与附加工具"
if have lark-cli; then
  ok "lark-cli $(lark-cli --version 2>/dev/null | first_line)"
  info "接飞书通道用：lark-cli config init；查登录：lark-cli auth status / lark-cli auth login。"
else
  soft "没找到 lark-cli（不接飞书通道可以没有）"
  fix "npm i -g @larksuite/cli，然后 lark-cli config init 建应用、lark-cli auth login 登录。只靠桌面通知也能用。"
fi

if have gh; then
  ok "gh $(gh --version 2>/dev/null | first_line)"
else
  soft "没找到 gh（可选：给 GitHub 事件/交付流水线用）"
  fix "brew install gh 或见 https://cli.github.com/；用不到 GitHub 集成就跳过。"
fi

if have agent-autoloop; then
  ok "agent-autoloop $(agent-autoloop --version 2>/dev/null | first_line)"
else
  soft "还没安装 agent-autoloop"
  fix "运行 bash bin/install-autoloop.sh（从上游安装，Node ≥ 24）。"
fi

case "$OS" in
  Darwin)
    if have osascript; then
      ok "桌面通知可用（osascript）"
    else
      soft "没找到 osascript，桌面通知通道会安静跳过"
    fi
    ;;
  Linux)
    if have notify-send; then
      ok "桌面通知可用（notify-send）"
    else
      soft "没找到 notify-send（桌面通知通道会安静跳过；有图形桌面时装 libnotify-bin）"
      fix "sudo apt install libnotify-bin（Debian/Ubuntu）。只靠飞书通道也能用。"
    fi
    ;;
esac

# ---------------------------------------------------------------- 磁盘与网络
section "磁盘与网络"
DISK_LINE="$(df -Pk "${HOME:-/}" 2>/dev/null | awk 'NR==2 {print $4" "$5}')"
DISK_AVAIL_KB="${DISK_LINE%% *}"
DISK_USED="${DISK_LINE##* }"
case "$DISK_AVAIL_KB" in
  ''|*[!0-9]*) soft "读不到磁盘剩余空间（df 输出异常），跳过" ;;
  *)
    DISK_AVAIL_GB=$((DISK_AVAIL_KB / 1024 / 1024))
    if [ "$DISK_AVAIL_KB" -lt 1048576 ]; then
      bad "磁盘剩余 ${DISK_AVAIL_GB}GB（少于 1GB，装不下/跑不动）"
      fix "清理磁盘，至少留 2GB 空闲再继续。"
    elif [ "$DISK_AVAIL_KB" -lt 5242880 ]; then
      soft "磁盘剩余 ${DISK_AVAIL_GB}GB（建议 ≥ 5GB，安装与日志都需要空间）"
      fix "清一下 ~/Downloads、旧日志；日志主要在 ~/.agent-autoloop/logs 和已装 Agent 自己的目录。"
    else
      ok "磁盘剩余 ${DISK_AVAIL_GB}GB（已用 ${DISK_USED}）"
    fi
    ;;
esac

if have curl; then
  if curl -fsSI -m 6 https://raw.githubusercontent.com >/dev/null 2>&1 || curl -fsSI -m 6 https://github.com >/dev/null 2>&1; then
    ok "外网连通（安装/更新时能访问 GitHub）"
  else
    soft "访问 GitHub 失败或超时（安装 autoloop 需要外网；公司网络/代理环境常见）"
    fix "换网络或配置代理后重试；内网可把上游仓库 clone 到本地，用 AGENT_AUTOLOOP_REPO=<本地目录> bash bin/install-autoloop.sh。"
  fi
fi

# ---------------------------------------------------------------- 权限说明
section "权限说明"
if [ "$OS" = "Darwin" ]; then
  info "macOS 不需要开「辅助功能」：本套件不含 Grok/Muse/桌面自动化桥，DSH/Codex/Claude 都是命令行 Agent，桌面通知用 osascript 内置能力。"
fi
info "不需要 sudo 安装 autoloop：它装在 ~/.agent-autoloop，系统服务是用户级 launchd/systemd。"

# ---------------------------------------------------------------- 汇总
section "结论"
if [ "$HARD_FAIL" = 1 ]; then
  printf '❌ 有硬性依赖缺失，按上面的「↳ 修复」装好再重跑 bash bin/env-check.sh。\n'
  exit 1
fi
printf '✅ 没有硬性项缺失。⚠️ 项不影响继续，按需补齐。\n'
printf '   下一步：bash bin/install-autoloop.sh\n'
exit 0
