# 排障手册

> 原则：先看日志/状态，再动手；每个脚本都会备份，修不好就回滚备份再求助。

## 0. 一键定位

先跑流程化 E2E（只读，不发消息），它会告诉你哪一层断了：

```bash
cd ~/tieka-console && bash tests/e2e.sh
```

```bash
cd ~/tieka-console
./verify-install.sh --dsh-url http://127.0.0.1:<DSH端口> \
  --review-profile tieka-review --task-profile tieka-task 2>&1 | tee /tmp/tieka-verify.log
```

它会把失败项标 ❌。下面按模块排查。

## 1. 环境 / 安装

| 症状 | 检查 | 处理 |
|---|---|---|
| `Node 需要 ≥ 24` | `node --version` | brew 装 node@24 并把 `$(brew --prefix node@24)/bin` 加进 PATH；或 nvm |
| `找不到 dsh` | `which dsh` | 装好 DSH 桌面版后，CLI 通常在 `~/.npm-global/bin`；把该目录加入 PATH |
| `找不到 lark-cli` | `lark-cli --version` | `npm i -g @larksuite/cli` |
| `claude/codex CLI 不可用` | `claude --version`、`codex --version` | 安装并**登录**；autoloop 的 launchd 环境用登录 shell 的 PATH |
| plugin_manager 被拒 | 会话审批 | 让用户给 Full access 或逐个审批；安装命令只接受本地目录 |

## 2. autoloop 中台

| 症状 | 检查 | 处理 |
|---|---|---|
| `中台没在跑` | `agent-autoloop status`；`launchctl print gui/$(id -u)/agent-autoloop` | `agent-autoloop service install` 或 `agent-autoloop up`；看 `~/.agent-autoloop/logs/up.log` |
| `rules.json 校验失败` | `agent-autoloop check` | 按输出改；旧规则会继续跑并推一张错误卡；恢复备份：`~/.agent-autoloop/rules.json.bak-*` |
| 卡片不推送 | `agent-autoloop status` 看通道是否在线；`~/.agent-autoloop/logs/up.log` | 检查 `config.json` 的 channels.feishu key/user、wrapper 是否存在且可执行、lark-cli profile 是否过期 |
| 回答卡片后不继续 | `agent-autoloop why <run>` | 看回执是否 rejected；卡片 answerers 是否包含你 |

## 3. DSH 插件

| 症状 | 检查 | 处理 |
|---|---|---|
| 装完没图标 | 刷新页面；Plugin Manager 是否 enabled | 刷新/重启 DSH；`plugin_manager set_bundle enabled:true` |
| 面板显示「没找到 autoloop 中台」 | `~/.agent-autoloop/config.json` 是否存在；中台是否在跑 | 先装 autoloop 再装插件；面板会显示安装步骤 |
| Agents 页空 | `curl http://127.0.0.1:<端口>/agents/summary` | 观察台没装/未启用；看 DSH 插件列表；重启 DSH |
| 插件安装 warnings 非空 | 安装返回 | 不要把 warnings 当成功；按提示修（常见：engines 版本、包清单） |

## 4. 审阅机器人（卡片/审批/汇报）

| 症状 | 检查 | 处理 |
|---|---|---|
| 飞书收不到卡片 | `agent-autoloop status` 通道在线？`~/.agent-autoloop/logs/up.log` 有 feishu 报错？ | 检查应用是否开启机器人、发布版本、可用范围含你；事件 `card.action.trigger` 是否订阅（长连接）；wrapper profile 是否正确（`~/.agent-autoloop/lark-feishu.sh`） |
| 卡片能收到但点按钮无效 | `rules.json` 的 `channels.feishu.answerers` 是否含你的 open_id | 用 `setup-review-bot.sh --profile <审阅profile> --owner <open_id>` 重配；open_id 必须是**审阅应用**下的 |
| 30 分钟汇报收不到 | `curl /agents/notify/state` 看 `hub.configured`、`lastReportAt` | 观察台没连上 autoloop（source key）；或处于免打扰；或 reportEnabled=false |
| 测试卡收不到 | `POST /agents/notify/test` 返回 error | 看 autoloop 日志里 `/v1/tell` 是否 401（source key 不对） |

**注意**：审阅应用的 open_id 与任务应用不同（飞书 open_id 按应用隔离）。白名单/answerers 都要用对应应用下的 open_id。

## 5. 任务发布机器人

| 症状 | 检查 | 处理 |
|---|---|---|
| 飞书发消息无回复 | `~/.dsh-lark-bot/logs/bot-<日期>.log` | ① 机器人是否已发布、可用范围含你 ② 事件 `im.message.receive_v1` 是否订阅（长连接）③ 权限 `im:message.p2p_msg:readonly` 等是否审批 ④ `launchctl print gui/$(id -u)/${DSH_LARK_BOT_LABEL:-com.tieka.dsh-lark-bot}` |
| 回了「⛔ 未授权」 | 日志里有 `忽略未授权发送者 ou_xxx` | 用该 open_id 重跑 `feishu/setup-task-bot.sh --profile <p> --owner ou_xxx`，重启 bot |
| 回了错误/卡住 | `~/.dsh-lark-bot/logs/bot-<日期>.log`；DSH headless 输出 | 常见：DSH 并发被上一个任务占着（等或飞书发 `/stop`）、`dsh` 不在 launchd PATH、任务超时（`taskTimeoutMs`） |
| `lark-cli` profile 过期 | `lark-cli --profile <p> auth status` | `lark-cli --profile <p> auth login` 重新授权 |
| 找不到机器人 | 飞书联系人搜索 | 开放平台 → 版本发布 + 可用范围；或让管理员在「工作台」可见 |

## 6. 观察台（Claude / Codex / DSH 进度）

| 症状 | 检查 | 处理 |
|---|---|---|
| 进度为空/旧 | `curl /agents/claude/steps?limit=5` | 会话目录是否存在、权限是否可读；刚跑完的步骤可能延迟几秒 |
| Codex 显示很旧 | `~/.codex/sessions` 是否有新 rollout | Codex CLI 是否在用 `~/.codex`；桌面端和 CLI 可能不同库 |
| DSH 会话读不出 | `~/.dsh/sessions/**/session.v4.jsonl.zstd` 是否存在 | DSH 会话格式随版本变；升级 DSH 后如格式变化需要更新 observer |
| 汇报里只有 3 行（正常） | 确认是 lite 版 | 本套件已去掉 Grok/Muse |

## 7. Claude / Codex 派活失败

```bash
agent-autoloop status            # Agent 是否在线
agent-autoloop why <run>         # 这一轮发生了什么
```

- Claude：确认 `claude -p "hi"` 能跑；`access` 是否合适。
- Codex：确认 `codex exec ...` 能跑；桌面端登录不等于 CLI 登录。
- launchd/systemd 环境的 PATH 与登录 shell 不同：autoloop worker 会用登录 shell 找程序，若仍找不到，把 CLI 绝对路径写进 rules.json 的 command。

## 8. 想加新东西

| 想加 | 改哪里 |
|---|---|
| 新规则 | `~/.agent-autoloop/rules.json`（参考 `configs/autoloop/rules.example.md`），改完 `agent-autoloop check` |
| 新通知/审批渠道 | autoloop 通道插件（上游 docs/plugins.md） |
| 新监控对象 | 观察台 `lib/agents/` 加 collector（参考 claude.js） |
| 汇报频率/免打扰 | `~/.cache/dsh-agent-observer/notify.json` |
| 面板文案/图标 | `plugins/dsh-autoloop-panel/{locale,icon.svg}`，改完刷新 DSH |
