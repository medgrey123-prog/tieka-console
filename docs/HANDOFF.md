# 交接说明（把「铁卡老弟」交给另一台电脑）

## 0. 交付物

- GitHub（私有）：<https://github.com/medgrey123-prog/tieka-console>
- 离线包：`tieka-console-<日期>.zip`（可从仓库根目录打包，排除 `.git`）
- 对方只需要：一台 macOS、DSH 桌面版、Claude Code CLI、Codex CLI、Node ≥ 24、lark-cli，以及**两个自己的国内飞书应用**。

## 1. 三种交付方式

### A. GitHub（推荐，能更新）

私有仓库需要先把对方加为 collaborator：

```bash
# 把 <对方的GitHub用户名> 换成实际用户名
gh api repos/medgrey123-prog/tieka-console/collaborators/<对方的GitHub用户名> -X PUT -f permission=push
```

对方机器上：

```bash
git clone https://github.com/medgrey123-prog/tieka-console.git ~/tieka-console
```

> 也可以把仓库改成公开：`gh repo edit medgrey123-prog/tieka-console --visibility public --accept-visibility-change-consequences`（仓库里没有密钥，但仍建议看完 `docs/SECURITY.md` 再决定）。

### B. 离线 zip（对方不方便用 GitHub）

在本机打包（排除 git 历史）：

```bash
cd ..    # 进入 tieka-console 的上一级目录
zip -r tieka-console-$(date +%Y%m%d).zip tieka-console -x "tieka-console/.git/*"
```

把 zip 发给对方，解压到 `~/tieka-console` 即可。后续更新需要重新发 zip。

### C. 当面/同局域网

直接 `rsync -av --exclude .git tieka-console/ 对方:~.../tieka-console/`。

## 2. 对方怎么开始

对方机器上：

```bash
cd ~/tieka-console
bash bin/env-check.sh      # 先确认环境
```

然后在 **DSH 里**（`cwd=~/tieka-console`，让 DSH 自动读 AGENTS.md）新开会话，发这段：

> 你在 ~/tieka-console 里。读 AGENTS.md，按 INSTALL.md 的顺序把「铁卡老弟」装好。
> 每步先检查现状、保持幂等；到需要我提供飞书 App ID/Secret、审批 plugin_manager 安装插件、或首次白名单 open_id 时停下来问我；
> 装完跑 ./verify-install.sh 并对照 README 的验收清单逐项验证，失败就修到通过，最后给我「装了什么、怎么用、怎么改」的说明。

对方需要配合的只有三件事（DSH 会在对应步骤停下来问）：

1. 在飞书开放平台建两个应用，给 **App ID / App Secret**（Secret 让用户自己粘到终端的 stdin，不贴聊天）
2. 在 DSH 里批准两次 `plugin_manager install_bundle`（Full access）
3. 给任务发布机器人发一条「你好」，把返回的 **open_id** 交给 DSH（或让 DSH 读日志）

## 3. 装完对方会得到什么

- DSH 侧栏「铁卡老弟」面板：总览 / 卡片审批 / 在跑排队 / 花费 / Agents（Claude/Codex/DSH）
- 飞书「审阅机器人」：审批卡片 + 每 30 分钟 Agent 汇报 + 异常提醒
- 飞书「任务发布机器人」：聊天下指令 → 本机 DSH 执行 → 结果回飞书
- autoloop 规则：试跑、每日简报、每周复盘、代码任务（可自己加）

## 4. 验收清单（对方装完后跑）

先跑流程化 E2E：

```bash
cd ~/tieka-console
bash tests/e2e.sh --with-feishu --with-task-simulate
```

它会把「环境 → autoloop → DSH 面板/观察台 → 审阅机器人 → 任务机器人（真执行+真回飞书）→ DSH headless」逐层验证；
只读模式 `bash tests/e2e.sh` 不发任何消息。详见 [README.md](../README.md) 第 5 节与 [INSTALL.md](../INSTALL.md) 第 7 步；核心 7 项：

1. `agent-autoloop status` 中台/Agent/通道在线
2. DSH 面板出现「铁卡老弟」，Agents 页有 3 个 Agent
3. 审阅机器人能收卡片、点按钮能继续
4. 任务发布机器人能收消息并执行（回「安装成功」）
5. 30 分钟汇报（或手动 `/agents/notify/report`）收到
6. 异常测试（`/agents/notify/test`）收到
7. Claude/Codex 规则能派活（`agent-autoloop try` 或 cron 规则）

## 5. 对方想改

| 想改 | 看 |
|---|---|
| 汇报频率/免打扰 | `~/.cache/dsh-agent-observer/notify.json` |
| 规则/派活给谁 | `~/.agent-autoloop/rules.json` + `configs/autoloop/rules.example.md` |
| 机器人名字 | 飞书开放平台 → 应用 → 基础信息/机器人 → 改名 → 发版 |
| 任务机器人工作目录/白名单 | `~/.dsh-lark-bot/config.json`（用 `feishu/setup-task-bot.sh` 改） |
| 面板文案/图标 | `plugins/dsh-autoloop-panel/{locale,icon.svg}`，重装插件后刷新 |

## 6. 已知边界（交接时如实告知）

- 飞书开放平台的控制台步骤是**手工**的（手册 `docs/FEISHU-SETUP.md` 逐屏写清），脚本只能自动完成"拿到 App ID/Secret 之后"的部分。
- 本套件**未在全新机器上端到端跑过**：脚本在沙箱做了 dry-run/幂等/回滚测试，插件 selftest 39/39，但真实飞书租户与 clean install 需要对方按手册走一遍；卡住就把 `verify-install.sh` 输出与日志发回来。
- Windows 原生不支持（上游 autoloop 是 POSIX shell）；可用 WSL2。
- 不含 Grok Bot / Muse / 桌面 GUI 自动化（已确认不要）。
- 私有仓库更新后，对方 `git pull`，插件如无改动无需重装；有改动按 `plugins/README.md` 重装两次 `plugin_manager`。

## 7. 回滚

```bash
# 任务发布机器人
~/tieka-console/bots/dsh-lark-bot/botctl.sh stop && \
~/tieka-console/bots/dsh-lark-bot/botctl.sh uninstall
# DSH 插件：Plugin Manager 停用，或 plugin_manager set_bundle enabled:false
# autoloop：agent-autoloop uninstall（保留 ~/.agent-autoloop 数据）
```
