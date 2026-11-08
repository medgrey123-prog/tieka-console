# 环境要求（ENVIRONMENT）

本套件的目标：在一台 **macOS 或 Linux** 电脑上装好 **agent-autoloop** 中控台，让 DSH / Codex / Claude Code
按规则干活、用桌面通知或飞书卡片找人拍板。

先跑一遍自检，再按本文补缺：

```bash
bash bin/env-check.sh
```

- ✅ 通过；⚠️ 可选/建议项（不影响继续）；❌ 硬性缺失（装下去会卡住）。
- 自检退出码：没有 ❌ 时为 0。

## 0. 支持范围

| 平台 | 支持 | 说明 |
| --- | --- | --- |
| macOS 13+（Intel / Apple Silicon） | ✅ | 主支持平台；桌面通知用系统 `osascript`。 |
| Linux（含 WSL2 里的 Ubuntu） | ✅ | 桌面通知需要 `notify-send`；无图形桌面时通知会安静跳过，飞书通道照常。 |
| Windows 原生 | ❌ | 上游脚本是 POSIX shell，**不支持**。替代：① 用 WSL2 + Ubuntu；② 中控台放一台 Mac/Linux，Windows 只当业务机通过 HTTP 发事件。 |

本套件**不需要** macOS「辅助功能 / 屏幕录制 / 自动化」权限：不含任何桌面 GUI 自动化桥（Grok/Muse 那类），
DSH、Codex、Claude 都是命令行 Agent，唯一用的系统能力是桌面通知（osascript / notify-send）。

## 1. Node.js ≥ 24（硬性）

agent-autoloop 用 Node 跑，要求 **Node 24 或更新**；本套件里的命令也要求命令行能找到 `node`。

```bash
node -v        # 需要 v24.x 或更高
```

安装（二选一）：

```bash
# Homebrew（macOS；Linux 用 brew 或发行版包管理器装 Node 24）
brew install node@24
# node@24 默认不进 PATH，把这行加到 ~/.zshrc（bash 用 ~/.bashrc）：
echo 'export PATH="'"$(brew --prefix node@24)"'/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 或 nvm（macOS / Linux 通用）
nvm install 24
nvm alias default 24
nvm use 24
```

注意：

- **DSH 桌面版自带的 Node runtime 只给 DSH 自己用，不算命令行 Node。** `bin/install-autoloop.sh` 和
  `bin/apply-autoloop-config.sh` 需要 PATH 上的 `node`。
- 系统服务（launchd/systemd）启动中台时用的是登录 shell 的 PATH；Node 装在 nvm 里而 PATH 只在交互 shell 生效时，
  服务可能找不到 node。最稳的是用 Homebrew 的绝对路径，或在 `~/.zshrc` 里把 Node 的 bin 目录放到公共路径。
- 验证：`node -v`、`npm -v` 都能输出且版本 ≥ 24。

## 2. git 与 curl（硬性）

首次安装和 `agent-autoloop update` 需要 git；从上游下载安装脚本需要 curl。

```bash
# macOS：装命令行工具（自带 git/curl/python3）
xcode-select --install

# Debian / Ubuntu
sudo apt update && sudo apt install -y git curl
# Fedora
sudo dnf install -y git curl
```

## 3. Python 3（建议，规则模板生成需要）

`bin/apply-autoloop-config.sh` 用 python3 从模板生成 `rules.json`。没有 python3 也可以继续：
手写 `~/.agent-autoloop/rules.json`（照着 `configs/autoloop/rules.example.json`），再 `agent-autoloop check`。

```bash
python3 --version   # macOS 由 xcode-select --install 提供；Linux 一般自带
```

- Debian/Ubuntu：`sudo apt install -y python3`
- 本套件不依赖任何第三方 Python 包，只用标准库。

## 4. Agent（至少装一个并登录）

规则把活交给谁，机器上就得有对应的 CLI 并已登录。推荐三个都装：

| Agent | 用途 | 需要 |
| --- | --- | --- |
| **DSH**（`dsh --profile headless`） | 定时任务、批量整理（每日简报） | DSH 桌面版运行中 + `dsh` 在 PATH 上 |
| **Codex**（`codex`） | 只读排障、按事件改代码 | Codex CLI 已登录 |
| **Claude Code**（`claude`） | 需要编辑/归纳的复盘、整理 | Claude Code CLI 已登录 |

### 4.1 DSH 桌面版

- 安装 DSH 桌面版并登录、保持运行（`dsh web` 的那个桌面应用）。
- 命令行要能找到 `dsh`：`dsh --version` 有输出。找不到时把 DSH 安装时提示的 bin 目录加进 `PATH`。
- 本套件的规则用 **headless profile** 跑：

  ```bash
  dsh --profile headless "用一句话说明你收到了任务"   # 能跑完并输出结果即可
  ```

  版本要求：建议 DSH 0.2.x 或更新（`dsh --version` 确认）。DSH 只是「一个 command agent」，
  上游规则里换掉 `command` 就能用别的命令行 Agent 替代。

### 4.2 Claude Code CLI

```bash
npm i -g @anthropic-ai/claude-code
claude --version
claude          # 首次运行完成登录（浏览器授权）
claude auth status
```

### 4.3 Codex CLI

```bash
npm i -g @openai/codex
codex --version
codex login     # 用 ChatGPT 账号或 API Key 登录
```

规则里给 Codex 的权限是 `access: "read"`（只读排查），给 Claude 的是 `edit`；需要改文件时才放开。

## 5. 飞书通道（可选但推荐）

飞书通道用官方 `lark-cli`：

```bash
npm i -g @larksuite/cli
lark-cli --version

# 初始化应用（不同版本命令略有差异，优先用新版无参数形式）
lark-cli config init
# 旧版本可能是：lark-cli config init --new
# 按提示扫码创建/绑定飞书应用，并给应用开启「机器人」能力和卡片回传交互（长连接）

lark-cli auth login      # 登录本人账号（读业务资料时用本人身份）
lark-cli auth status
```

接入要点（细节见 `configs/autoloop/rules.example.md` 第 9 节）：

1. `rules.json` 的 `channels.feishu.answerers` 填**能回答卡片的人**的 open_id（以 `ou_` 开头）。
2. `config.json` 的 `channels.feishu` 填通道密钥与收件人（由飞书接入脚本/`agent-autoloop key new channel feishu` 生成）。
3. 两处都有同名通道才生效；改完 `config.json` 后 `agent-autoloop service install` 重启中台。
4. 同一个飞书应用的卡片点击只能有一台电脑在监听，不要在多台机器上重复接同一个应用。

不接飞书也能用：桌面通知（macOS `osascript` / Linux `notify-send`）会在卡片创建时弹一条通知；
生成规则时加 `--no-feishu` 去掉飞书通道。

## 6. 网络

- 首次安装：需要访问 GitHub（下载 install.sh + clone 上游仓库）。
- 内网/离线机器：把 <https://github.com/KKKKhazix/agent-autoloop> clone 到本机任意目录，然后

  ```bash
  AGENT_AUTOLOOP_REPO=/本地路径/agent-autoloop bash bin/install-autoloop.sh
  ```

- 中台默认只监听 `127.0.0.1:3350`，不对外暴露；跨机发事件/回答卡片需要隧道或按上游手册配置地址与密钥。
- 飞书通道是长连接（outbound），不需要公网 IP。

## 7. 磁盘与内存

- autoloop 本体 + 三个 Agent 的 CLI 大约几百 MB；日志和历史（`~/.agent-autoloop/logs`、`hub.db`）会慢慢长。
- 建议至少 **5GB 空闲磁盘、8GB 内存**（同时跑 DSH/Codex/Claude 时内存更重要）。
- 磁盘剩余少于 1GB 时自检会报 ❌。

## 8. 权限与安全

- **不需要 `sudo`**：autoloop 装在 `~/.agent-autoloop`，系统服务是用户级 launchd（macOS）/ systemd user（Linux）。
- **不需要 macOS 辅助功能/屏幕录制/完全磁盘访问**（本套件没有桌面自动化）。
- `~/.agent-autoloop/config.json`、`master.key`、各通道密钥、飞书 open_id 都不进仓库、不进聊天记录；
  模板与文档里只有 `{{占位符}}` 和示例。
- 规则里 `askFirst` 默认把「删数据、停服、花钱、对外发消息、改产品方向、新建或轮换密钥、修改权限」
  列为必须先问人的事；不要为了省事删掉。
- 会真实花钱的动作：`agent-autoloop try`、定时任务、Codex/Claude 里触发的业务。先用小频率 cron 验证。

## 9. 快速开始（环境齐了之后）

```bash
# 1. 安装/检查中台（Node ≥24）
bash bin/install-autoloop.sh

# 2. 建规则里要用的工作目录
mkdir -p ~/tieka-try ~/tieka-code ~/tieka-work

# 3. 生成规则（换成自己的飞书 open_id；还没有就先加 --no-feishu）
bash bin/apply-autoloop-config.sh --owner-open-id <飞书 open_id>

# 4. 校验并跑一遍完整闭环（try 会消耗模型额度）
agent-autoloop check
agent-autoloop status
agent-autoloop try

# 5. 看飞书/桌面通知是否收到卡片；按 configs/autoloop/rules.example.md 改成自己的规则
```

### 装完自检清单

```bash
agent-autoloop --version        # 有版本号
agent-autoloop check            # 「规则没问题。」
agent-autoloop status           # worker、通道在线；列出规则和 Agent
agent-autoloop doctor           # 逐项检查（系统服务没跑时会有提示）
```

## 10. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `install-autoloop.sh` 报 Node 版本过低 | PATH 上的 node 是旧版，或只有 DSH 自带 runtime | 装 Node 24，重开终端确认 `node -v`。 |
| `agent-autoloop: command not found` | 安装目录不在 PATH | 安装脚本会提示 alias；把 `~/.local/bin` 或 alias 加进 `~/.zshrc`。 |
| 服务起来了但 Agent 一直「离线」 | 服务 PATH 里没有 `dsh`/`codex`/`claude`，或 Agent 没登录 | 用绝对路径配 command，或把 CLI 的 bin 目录加进 PATH；分别登录一次。 |
| 规则里写了 `dsh` 但任务不派 | `worker` 和 `config.json` 的 `worker.name` 不一致 | 用 `agent-autoloop status` 看在线 worker，重跑 apply 脚本并传 `--worker`。 |
| 飞书卡片收不到 | `rules.json` 和 `config.json` 两处 `channels.feishu` 缺一，或改完没重启中台 | 两处都配好，`agent-autoloop service install` 重启；`agent-autoloop doctor` 看通道状态。 |
| `lark-cli config init` 参数不对 | 版本不同（新版 `config init`，旧版 `config init --new`） | 看 `lark-cli config init --help`。 |
| 定时任务时间不对 | cron 按规则 `timezone`（模板是 `Asia/Shanghai`）或本机时区 | 改 `timezone` 字段，或换算成本机时区。 |
| `agent-autoloop try` 卡住/失败 | 模型额度、登录状态、网络 | `agent-autoloop doctor`；确认 Agent 能单独跑起来再试。 |

更多：上游文档 <https://github.com/KKKKhazix/agent-autoloop>、
本套件 `configs/autoloop/rules.example.md`、`skills/agent-autoloop/SKILL.md`。
