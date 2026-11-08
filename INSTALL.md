# INSTALL — 从零到「铁卡老弟」状态

> 两种读者都能用：**人类**按顺序手工做；**DSH Agent** 按 [AGENTS.md](AGENTS.md) 的施工单执行本文。
> 全程都要求：先检查现状 → 再动手 → 每步有验证 → 失败可回滚。不要跳过第 0 步。

安装顺序（有依赖关系，别打乱）：

```
0 环境检查 → 1 建两个飞书应用 → 2 装 autoloop → 3 接审阅机器人并拿 owner open_id
→ 4 应用规则模板 → 5 装 DSH 插件 → 6 接任务发布机器人 → 7 配观察台汇报并验收 → 8 收尾
```

---

## 0. 环境检查

```bash
cd ~/tieka-console
bash bin/env-check.sh
```

硬性项（缺了先修）：Node ≥ 24、git、curl、`dsh`、`claude`、`codex`、`lark-cli`、DSH 桌面版在运行。
软性项：python3（只有配置脚本用，可无）、gh（可选）。

修法见 [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)。

---

## 1. 创建两个国内飞书机器人

照 [docs/FEISHU-SETUP.md](docs/FEISHU-SETUP.md) 创建两个**企业自建应用**（国内版 open.feishu.cn）：

| 角色 | 名字 | 关键能力 |
|---|---|---|
| 审阅机器人 | `审阅机器人` | 机器人；发消息/卡片；订阅 `card.action.trigger`（长连接） |
| 任务发布机器人 | `任务发布机器人` | 机器人；收单聊消息 `im.message.receive_v1`（长连接）；以应用身份发消息 |

创建后各自「创建版本 → 发布」，并把**可用范围**设成包含你自己。
记下两个应用的 **App ID** 和 **App Secret**（Secret 只显示一次，先存好；不要提交进任何仓库）。

> 也可以让任务发布机器人用 lark-cli 的建应用向导自动创建：
> `lark-cli config init --new --name tieka-task --brand feishu`，按提示在浏览器完成。
> 审阅机器人建议手工建，方便控制权限。

**验收**：两个应用「已发布」，机器人都已添加到你的飞书联系人。

---

## 2. 安装 agent-autoloop

```bash
bash bin/install-autoloop.sh
mkdir -p ~/tieka-try ~/tieka-code ~/tieka-work   # 规则模板里的三个工作目录
agent-autoloop --version
agent-autoloop status        # 中台/Agent/通道在线
```

- 脚本会检查 Node ≥ 24，未安装则从上游 `install.sh` 安装；macOS 会注册 launchd 常驻服务。
- 安装完 `~/.agent-autoloop/{config.json,rules.json,master.key,...}` 会生成，`init` 会创建 owner/worker/source 密钥。
- 自检：`agent-autoloop doctor`（只有「系统服务没在跑」这条可忽略，如果你用了 `--no-service`）。

**验收**：`agent-autoloop status` 能看到本机 worker 在线、桌面通知通道在线。

---

## 3. 接审阅机器人（并拿到你的 open_id）

1. 先给审阅机器人应用建一个 lark-cli profile，并扫码登录拿到你在该应用下的 **user open_id**：

```bash
# 推荐：让脚本引导登录并打印 open_id
bash feishu/setup-review-bot.sh --profile tieka-review --app-id <审阅机器人APP_ID> --login
```

按提示用**你的飞书**扫码/授权；脚本会输出 `OPEN_ID=ou_xxx`。

2. 用同一个 App Secret 真正接入 autoloop（通道密钥、wrapper、config.json）：

```bash
bash feishu/setup-review-bot.sh \
  --profile tieka-review \
  --app-id <审阅机器人APP_ID> \
  --owner <OPEN_ID> \
  < <(printf '%s' '<审阅机器人APP_SECRET>')
```

> 上面写法是为了让 Secret 走 stdin、不出现在进程列表；也可以交互式粘贴。

脚本会：
- 写 `~/.agent-autoloop/lark-feishu.sh`（固定 profile 的 lark-cli wrapper）
- `agent-autoloop key new channel feishu` 生成通道密钥
- patch `~/.agent-autoloop/config.json` 的 `channels.feishu`（key/user/lark）
- 备份并 patch `~/.agent-autoloop/rules.json` 的 `channels.feishu`（name=审阅机器人, answerers=[你]）
- 提示重启中台服务

**验收**：`agent-autoloop status` 里通道 `审阅机器人` 在线；`agent-autoloop tell test-1 "测试"` 能在飞书收到一张「本机」通知（这条走审阅机器人）。

---

## 4. 应用 autoloop 规则模板（DSH / Claude / Codex）

```bash
bash bin/apply-autoloop-config.sh --owner-open-id <OPEN_ID>
agent-autoloop check
```

- 模板包含三个 agent：`dsh`（`dsh --profile headless {prompt}`）、`claude`（`use:"claude"`）、`codex`（`use:"codex"`），以及 4 条示例规则：试跑、每日简报、每周复盘、代码任务。
- 脚本会备份原 `rules.json`，置换 `<WORKER_NAME>` / `<OWNER_OPEN_ID>` / 工作目录占位符，失败自动回滚。
- 想加自己的规则看 [configs/autoloop/rules.example.md](configs/autoloop/rules.example.md)。

重启中台让配置生效：

```bash
# macOS（安装器注册了 launchd 时）
launchctl kickstart -k gui/$(id -u)/agent-autoloop
# 或手动
agent-autoloop service install   # 幂等
```

**验收**：`agent-autoloop status` 列出 4 条规则、3 个 Agent；`agent-autoloop why` 能看到规则版本。

---

## 5. 安装 DSH 插件（铁卡老弟面板 + 观察台）

在 **DSH 会话里**（不是终端）让 Agent 执行两次插件安装（需要 Full access 或审批）：

```text
plugin_manager({ action: "install_bundle", target: "<repo绝对路径>/plugins/dsh-autoloop-panel" })
plugin_manager({ action: "install_bundle", target: "<repo绝对路径>/plugins/dsh-agent-observer" })
```

- 返回 `application: applied` 即生效；`warnings` 必须为空。
- 装完 **刷新 DSH 页面**（Cmd+R）；必要时重启 DSH 一次。
- 插件只读 autoloop 的 `/v1/state` 与本机会话文件，不会改你的项目。

**验收**：
- 侧栏出现「铁卡老弟」→ 总览有轮次/花费；点开 Agents 页能看到 Claude/Codex/DSH 三行
- 用免审批的 inspect 确认（Agent 可做）：`cordis_inspect_query(host, Config, listConfigs, {name:"@local/dsh-autoloop-panel"})` 有行；client `Slots` 里 `main` 有 `autoloop`。

---

## 5.5 安装 DSH 技能（让任务机器人稳定按“你的用法”干活）

把本仓库的 skills 装到 DSH 的全局技能目录（headless 会话也会加载）：

```bash
mkdir -p ~/.dsh/skills ~/.claude/skills
cp -R ~/tieka-console/skills/feishu-task-ops ~/.dsh/skills/
cp -R ~/tieka-console/skills/agent-autoloop  ~/.dsh/skills/
# 可选：让 Claude Code 的 agent 也认识 autoloop 命令
cp -R ~/tieka-console/skills/agent-autoloop  ~/.claude/skills/ 2>/dev/null || true
```

- `feishu-task-ops`：约束任务发布机器人如何理解指令、什么情况先问、结果怎么回（这是"输入设定"的核心）。
- `agent-autoloop`：让 Agent 会读规则/回执/事件，方便在飞书里说「把这活派给 Codex」时正确使用 autoloop。

**验收**：在 DSH 会话里问 Agent「你有哪些和 feishu 有关的 skill」，应能看到 `feishu-task-ops`（新会话生效）。

## 6. 接任务发布机器人

1. 加 profile、写 wrapper、生成配置、装 launchd：

```bash
bash feishu/setup-task-bot.sh \
  --profile tieka-task \
  --app-id <任务发布机器人APP_ID> \
  < <(printf '%s' '<任务发布机器人APP_SECRET>')
```

2. 首次白名单引导：在飞书给「任务发布机器人」发一句话（如「你好」）。
   - 未授权时它会回复你的 **open_id**（也可能写在 `~/.dsh-lark-bot/logs/bot-<日期>.log`）
   - 拿到后重跑脚本加白名单：

```bash
bash feishu/setup-task-bot.sh --profile tieka-task --owner <OPEN_ID>
```

3. 验收：再发一句「回我一句安装成功」，飞书收到回复；日志 `[INFO] ✅ 事件监听已就绪`。

**验收细节**：
- `lark-cli event status` 里任务发布机器人有 `im.message.receive_v1` consumer
- `~/.dsh-lark-bot/config.json` 的 `larkBin` 指向 wrapper、`allowedUsers` 含你

---

## 7. 配置观察台汇报、联调与验收

观察台默认：**每 30 分钟**一份 3 个 Agent 的运行汇报，23:00–08:00 免打扰，异常即时提醒，全部走 autoloop → 审阅机器人。

1. 立刻验证推送链路（不需要等 30 分钟）：

```bash
# 在 DSH 会话里（或终端；DSH 端口以实际 Web GUI 为准，通常 5xxxx）
curl -s -X POST http://127.0.0.1:<DSH_PORT>/agents/notify/test
curl -s -X POST http://127.0.0.1:<DSH_PORT>/agents/notify/report
```

两下都应让审阅机器人收到卡片（一条测试、一条完整汇报）。
返回里 `sent:true` 即成功；飞书失败看 `error`。

2. 调频率/免打扰：`~/.cache/dsh-agent-observer/notify.json`

```json
{ "reportIntervalSec": 1800, "quietHours": { "start": 23, "end": 8 } }
```

3. 全量验收：

```bash
cd ~/tieka-console && ./verify-install.sh
```

再对照 README 第 5 节的 7 项清单手工点一遍（面板、飞书卡片、任务机器人、汇报、异常、Claude/Codex 派活）。

---

## 8. 收尾

- **改机器人名字**：飞书开放平台 → 应用 → 基础信息/应用能力-机器人 → 改名 → 创建版本发布。App ID 不变，配置不用动。
- **开机自启**：autoloop service + dsh-lark-bot 的 launchd 都已注册；`launchctl print gui/$(id -u)/${DSH_LARK_BOT_LABEL:-com.tieka.dsh-lark-bot}` 可查。
- **保密**：`~/.agent-autoloop/master.key`、两个 App Secret、lark-cli keychain、`~/.dsh-lark-bot/config.json` 只在本机；别提交、别贴群。
- **卸载/回滚**：
  ```bash
  # 任务发布机器人
  ~/tieka-console/bots/dsh-lark-bot/botctl.sh stop && \
  ~/tieka-console/bots/dsh-lark-bot/botctl.sh uninstall
  # DSH 插件：Plugin Manager 停用，或 plugin_manager set_bundle enabled:false
  # autoloop：agent-autoloop uninstall（保留规则/密钥/记录），配置在 ~/.agent-autoloop
  ```
- 排障见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。
