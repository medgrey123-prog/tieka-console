# 铁卡老弟 · DSH 中控台复制包

把一套**已经在我们自己电脑上跑通**的「个人 Agent 中控台」搬到另一台 Mac 上：
**DeepSeek Harness（DSH）当大脑 + Claude Code / Codex 当工人 + agent-autoloop 当调度与审批内核 + 两个国内飞书机器人当输入和输出口。**

目标：对方（或对方的 DSH Agent）按 [INSTALL.md](INSTALL.md) 一步步做，最后得到和这边一样的「铁卡老弟」状态。

---

## 1. 你会得到什么

```
                         ┌──────────────────────────── 你的 Mac ────────────────────────────┐
  飞书「任务发布机器人」 ──▶ │ dsh-lark-bot（launchd 常驻）                                      │
  （你打字下指令）          │   └─ dsh --profile headless "你的话"                             │
                         │         ├─ 直接干活（文件/命令/网络/技能）                           │
                         │         └─ 需要时交给 autoloop 规则（Claude Code / Codex）           │
                         │                                                                  │
  飞书「审阅机器人」 ◀──── │ agent-autoloop 内核（规则/排队/挂起审批/事实日志）                    │
  （卡片/审批/30 分钟汇报）  │   ▲            ▲                                                 │
                         │   │            └─ dsh-agent-observer（看 Claude / Codex / DSH 进度）│
                         │   └──────────────── dsh-autoloop-panel（DSH 侧栏「铁卡老弟」面板）   │
                         └──────────────────────────────────────────────────────────────────┘
```

装完你会得到：

| 能力 | 形态 |
|---|---|
| **中控台面板** | DSH 侧栏「铁卡老弟」图标：待审批卡片、在跑/排队、花费、Claude/Codex/DSH 当前进度 |
| **任务下派** | 在飞书给「任务发布机器人」说人话 → 本机 DSH 真正执行 → 结果回飞书 |
| **审批闭环** | 需要你拍板的事（删数据/花钱/对外发消息）变成「审阅机器人」卡片，点按钮才继续 |
| **监控与汇报** | 每 30 分钟一份 Agent 运行汇报（Claude/Codex/DSH 各自在干嘛、有没有问题）→ 审阅机器人 |
| **异常提醒** | 某 Agent 读不到/恢复时，立即推一条飞书 |
| **定时与事件** | agent-autoloop 规则：cron、事件、失败重试、到点复查、事实日志 |

**不包含**（有意去掉，避免把别人电脑变成难维护的 GUI 自动化现场）：
Grok Bot、Muse、桌面截图/OCR、鼠标键盘模拟、agent-desktop、桌面桥、以及我们私有的 watch-radar 巡检规则。

---

## 2. 目录结构

```
tieka-console/
├─ README.md / INSTALL.md / AGENTS.md    # 本说明、安装手册、给 DSH Agent 的施工单
├─ bin/                                  # 安装/配置/环境检查/验收脚本
├─ plugins/
│  ├─ dsh-autoloop-panel/                # DSH 面板插件（铁卡老弟）
│  └─ dsh-agent-observer/                # DSH 观察台插件（Claude/Codex/DSH，30 分钟汇报）
├─ bots/dsh-lark-bot/                    # 任务发布机器人（vendored，含 macOS launchd 管理）
├─ feishu/                               # 两个飞书机器人的接入脚本
├─ configs/autoloop/                     # autoloop 规则模板（DSH/Claude/Codex）
├─ vendor/agent-autoloop/                # 上游 autoloop 固定快照（MIT，离线安装，2.0MB）
├─ skills/
│  ├─ agent-autoloop/                    # autoloop 官方 Skill（MIT，随上游）
│  └─ feishu-task-ops/                   # 任务发布机器人的"输入设定"（headless DSH 行为规范）
└─ docs/                                 # 架构、飞书配置手册、环境、排障、安全、交接
```

---

## 3. 前置条件（完整版见 [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)）

- macOS（Linux 也可，脚本以 macOS 为主）
- **Node.js ≥ 24**（autoloop 要求；DSH 自带 runtime 不算）
- Git、curl
- **DSH 桌面版**已安装并登录、能开 Web GUI
- **Claude Code CLI**（`claude`）已安装并登录
- **Codex CLI**（`codex`）已安装并登录
- **lark-cli**：`npm i -g @larksuite/cli`
- 国内飞书（open.feishu.cn）**两个企业自建应用**：审阅机器人 + 任务发布机器人（手册见 [docs/FEISHU-SETUP.md](docs/FEISHU-SETUP.md)）
- 不需要：macOS 辅助功能/屏幕录制权限、Python（仅个别维护脚本会用到，可无）
- **autoloop 已随仓库自带**（`vendor/agent-autoloop` 固定快照）：装 autoloop 不需要联网、不需要 git；
  只有 npm 安装 lark-cli、建飞书应用需要网络

---

## 4. 怎么装（两种方式）

仓库：<https://github.com/medgrey123-prog/tieka-console>（公开；交接见 [docs/HANDOFF.md](docs/HANDOFF.md)）

### 方式 A：你亲手装（照 INSTALL.md 做）

```bash
git clone https://github.com/medgrey123-prog/tieka-console.git ~/tieka-console
cd ~/tieka-console
bash bin/env-check.sh          # 先看缺什么
open INSTALL.md                # 按 0→8 步做
```

### 方式 B（推荐）：让 DSH 自己装

1. 把仓库 clone 到目标机器
2. 打开 DSH，在**仓库目录**新开一个会话（`cwd=~/tieka-console`，这样它会自动读到 AGENTS.md）
3. 把这句话发进去：

> 你在 ~/tieka-console 里。读 AGENTS.md，按 INSTALL.md 的顺序把「铁卡老弟」装好。
> 每步先检查现状、保持幂等；到需要我提供飞书 App ID/Secret、审批 plugin_manager 安装插件、或首次白名单 open_id 时停下来问我；
> 装完跑 bin/verify.sh 并对照验收清单逐项验证，失败就修到通过，最后给我一份「装了什么、怎么用、怎么改」的说明。

DSH 会按施工单执行；你只需要在几个闸口点头/给凭据。

---

## 5. 验收（装完必须全绿）

| # | 检查 | 怎么验 |
|---|---|---|
| 1 | 中控台在跑 | `agent-autoloop status` 显示中台/Agent/通道在线 |
| 2 | 面板出现 | DSH 侧栏出现「铁卡老弟」→ 总览能看到轮次/花费；Agents 页能看到 Claude/Codex/DSH 三行 |
| 3 | 审阅机器人通 | 触发一张卡片（如 `agent-autoloop emit`），飞书收到；点按钮能回答并继续 |
| 4 | 任务机器人通 | 飞书给「任务发布机器人」发「你好」，它回你；发「在当前目录建个 hello.txt 写 123」能执行并回结果 |
| 5 | 汇报通 | 等到下一次 30 分钟汇报，或手动 `POST /agents/notify/report`，审阅机器人收到 3 个 Agent 的运行汇报 |
| 6 | 异常提醒通 | `POST /agents/notify/test` 收到测试卡 |
| 7 | Claude/Codex 可派活 | 用一条 `task.*` 事件或 cron 规则触发，autoloop run 里看到对应 agent 执行 |

### 流程化 E2E（推荐）

```bash
# 1) 只读：环境 / 中台 / 面板 / 观察台 / 机器人配置（不发任何消息）
bash tests/e2e.sh

# 2) 真发：飞书「审阅机器人」测试卡 + autoloop 通知卡（会问你收到没）
bash tests/e2e.sh --with-feishu

# 3) 全量：再加上任务机器人完整链路（模拟入站 → DSH 执行 → 真回飞书）
bash tests/e2e.sh --with-feishu --with-task-simulate
```

脚本会自动发现本机 DSH 端口；`--yes` 用于无人值守（发送项标记为"待人工确认"）。
详细命令见 [INSTALL.md](INSTALL.md) 第 7 步。

---

## 6. 安全与边界

- 所有密钥（飞书 App Secret、autoloop 的 key、`master.key`、lark-cli token）只留在本机 `~/.agent-autoloop`、`~/.lark-cli`、`~/.dsh-lark-bot`，权限 0600/0700；仓库里只有占位符。
- 飞书机器人白名单只允许你本人 open_id；别人发消息会被忽略。
- autoloop 默认只听 `127.0.0.1`；DSH 面板路由也是本机。
- 任务发布机器人会让 DSH headless **真的执行**你发的话（有用户权限）——只加你信任的人进白名单。
- 详见 [docs/SECURITY.md](docs/SECURITY.md)。

---

## 7. 卸载 / 回滚

```bash
# 任务发布机器人
~/.dsh-lark-bot/... 或 bots/dsh-lark-bot/botctl.sh uninstall
# 飞书通道 / 面板：在 DSH 插件管理里停用，或 plugin_manager set_bundle enabled:false
# autoloop：agent-autoloop uninstall（默认保留规则/密钥/记录）
```

具体见 [INSTALL.md](INSTALL.md) 第 8 步。

---

## 8. 来源与许可

- 调度内核：[agent-autoloop](https://github.com/KKKKhazix/agent-autoloop)（MIT；本仓库 `vendor/agent-autoloop/` 为固定快照，改动见 `vendor/README.md`）
- 任务发布机器人：本仓库 `bots/dsh-lark-bot/`（vendored，来源与改动见 `bots/dsh-lark-bot/SOURCE.md`，MIT）
- DSH 插件 API：DeepSeek Harness 的公开扩展点
- 本仓库：MIT（见 [LICENSE](LICENSE)）
