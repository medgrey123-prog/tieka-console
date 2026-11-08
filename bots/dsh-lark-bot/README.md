# 任务发布机器人 · dsh-lark-bot（随 tieka-console 套件）

在飞书给「任务发布机器人」发一句话，这台 Mac 上的 **DeepSeek Harness（DSH）** 真正去执行——
跑命令、改文件、查资料、调技能，进度和最终结果回到飞书对话。

- 飞书消息 → `im.message.receive_v1` 长连接（无需公网 IP / 域名 / 证书）→ `bot.mjs` → `dsh --profile headless`
- 同一飞书会话 ↔ 同一个 DSH session，**上下文连续**
- 白名单之外的人发消息会被拒绝，并收到自己的 open_id（用来引导加白名单）

> 本目录是上游 dsh-lark-bot 的 vendored 副本。来源、改动清单、升级方式见 [SOURCE.md](SOURCE.md)。
> 飞书应用的创建步骤（机器人能力 / 权限 / 事件 / 发布）见仓库文档 [../../docs/FEISHU-SETUP.md](../../docs/FEISHU-SETUP.md)。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 系统 | macOS（本目录的 launchd 脚本按 macOS 写；`bot.mjs` 本身跨平台） |
| Node.js | ≥ 20（推荐 22/24） |
| DSH | 已安装，且有 `headless` profile（`dsh --profile headless --json "你好"` 能跑） |
| lark-cli | `npm i -g @larksuite/cli`，版本 ≥ 1.0.98 |
| 飞书应用 | 国内飞书（open.feishu.cn）企业自建应用「任务发布机器人」，已发布、机器人能力已开、可用范围含你；权限与事件见 FEISHU-SETUP |
| 已登录 | 该应用已在 lark-cli 里建成 profile（由安装脚本自动创建） |

---

## 2. 安装（推荐：用套件脚本）

在仓库根目录（`tieka-console/`）执行。App Secret 只走 stdin，不出现在命令行/进程列表：

```bash
# 第 1 次：建 profile、写 wrapper、生成配置、装 launchd
bash feishu/setup-task-bot.sh \
  --profile tieka-task \
  --app-id <任务发布机器人APP_ID> \
  < <(printf '%s' '<任务发布机器人APP_SECRET>')
```

然后在飞书里给「任务发布机器人」发一句话（如「你好」）：

- 未授权时它会回复你的 **open_id**（也可能在 `~/.dsh-lark-bot/logs/bot-<日期>.log` 里）
- 拿到后重跑，把它加进白名单（**不需要再传 App Secret**）：

```bash
bash feishu/setup-task-bot.sh --profile tieka-task --owner <你的OPEN_ID>
```

验收：

```bash
bash bots/dsh-lark-bot/botctl.sh status      # launchd running + bot 状态
bash bots/dsh-lark-bot/botctl.sh doctor      # Node / DSH / lark-cli / 应用配置自检
```

再发一句「回我一句安装成功」，收到回复即通。

### 手动安装（理解脚本做了什么时用）

```bash
# 1) wrapper：固定 profile 的 lark-cli 入口（bot 的 larkBin 指向它）
mkdir -p ~/.dsh-lark-bot
printf '%s\n' '#!/bin/sh' 'exec "$HOME/.npm-global/bin/lark-cli" --profile tieka-task "$@"' \
  > ~/.dsh-lark-bot/lark-feishu-task.sh
chmod 700 ~/.dsh-lark-bot/lark-feishu-task.sh

# 2) 配置（从 config.example.json 复制后把 $HOME 展开，填 larkBin / workdir / ownerOpenId）
cp bots/dsh-lark-bot/config.example.json ~/.dsh-lark-bot/config.json
chmod 600 ~/.dsh-lark-bot/config.json
# 编辑 ~/.dsh-lark-bot/config.json：larkBin 指向上面的 wrapper；ownerOpenId / allowedUsers 填 open_id

# 3) 安装并启动 launchd
bash bots/dsh-lark-bot/botctl.sh install
```

---

## 3. 配置在哪里 / 优先级

`bot.mjs` 按以下顺序找配置（找到第一个就用）：

1. `$DSH_LARK_BOT_CONFIG`（显式指定路径，主要给测试用）
2. `$HOME/.dsh-lark-bot/config.json` ← **套件安装后就是这里**
3. 本目录 `config.json`（上游布局兼容；套件不创建它）

`--init` / `--doctor` / 启动都按同一路径。所以：

- 仓库里只有 `config.example.json`（模板，占位符），**永远不要把真实 config.json 提交进仓库**（`.gitignore` 已忽略）
- 想改配置：`vi ~/.dsh-lark-bot/config.json`，然后 `botctl.sh restart`
- 想看当前生效哪一份：`bash botctl.sh doctor` 或 `node bot.mjs --init` 的输出会打印路径

### 关键字段

| 字段 | 本套件默认 | 说明 |
|---|---|---|
| `larkBin` | `$HOME/.dsh-lark-bot/lark-feishu-task.sh` | 指向“固定 profile 的 lark-cli wrapper”，不要直接写 `lark-cli` |
| `dshProfile` | `headless` | DSH 用哪个 profile 执行任务 |
| `dshEntry` | `""`（自动探测） | 一般不用填；探测不到时填 DSH 的 `lib/bin.js` 绝对路径 |
| `workdir` | `$HOME` | 任务默认工作目录；**建议改成你真正干活的工作区** |
| `ownerOpenId` | `""` | 主人 open_id（首次通过「未授权」回复获取） |
| `allowedUsers` | `[]` | open_id 白名单；为空时只允许 `ownerOpenId` |
| `allowGroups` | `false` | 是否接受群聊消息 |
| `testChatId` | `""` | 可选；填了才能用 `--simulate` 自测（从 `/whoami` 或日志拿 chat_id） |
| `taskTimeoutMs` | `1800000` | 单任务超时 30 分钟 |
| `maxMessageAgeMs` | `900000` | 超过 15 分钟的旧消息不执行（防重启后补跑） |

---

## 4. 飞书里的斜杠命令

| 命令 | 作用 |
|---|---|
| `/new` | 开新会话（清空上下文） |
| `/stop` | 停止当前任务并清空队列 |
| `/status` | 会话 / 工作目录 / 队列状态 |
| `/cwd <目录>` | 切换执行工作目录 |
| `/whoami` | 显示你的 open_id / chat_id |
| `/ping` | 连通性测试 |
| `/help` | 帮助 |

---

## 5. 管理命令（macOS）

```bash
bash bots/dsh-lark-bot/botctl.sh install | uninstall | restart | start | stop | status | logs | doctor
bash bots/dsh-lark-bot/botctl.sh test "你好"    # 端到端自测：真的发飞书消息、真的执行（需 testChatId）
cd bots/dsh-lark-bot && node bot.mjs --init --force   # 按当前环境重建 config.json（已有字段保留）
cd bots/dsh-lark-bot && node bot.mjs --doctor         # 环境 + 飞书应用配置自检
```

launchd label 默认 `com.tieka.dsh-lark-bot`，可用 `DSH_LARK_BOT_LABEL` 覆盖；
plist 在 `~/Library/LaunchAgents/com.tieka.dsh-lark-bot.plist`，日志在 `~/.dsh-lark-bot/logs/`。

---

## 6. 自测与排错

| 现象 | 先看 | 常见原因 |
|---|---|---|
| 飞书发消息无回复 | `bash botctl.sh logs`；`bash botctl.sh doctor` | 应用未发布 / 可用范围不含你 / 事件没订阅 / 权限未审批 / 机器人能力没开 |
| 回「⛔ 未授权」 | 回复里的 open_id | 用 `--owner <open_id>` 重跑安装脚本（或手动填 `allowedUsers`）后 `botctl.sh restart` |
| 回复报错/卡住 | `~/.dsh-lark-bot/logs/bot-<日期>.log` | `dsh` 不在 launchd PATH、上一个任务占着并发、任务超时 |
| 装完 launchd 起不来 | `~/.dsh-lark-bot/logs/launchd.err.log` | Node 路径、目录权限、plist 里的路径 |
| `--simulate` 报缺 testChatId | 飞书 `/whoami` 或日志里的 `chat=oc_...` | 填进 config.json 的 `testChatId` |

`node bot.mjs --doctor` 会直接读飞书接口验证：机器人能力是否开通、事件订阅是否长连接、是否订阅了
`im.message.receive_v1`——装完先跑它。

---

## 7. 安全

- 机器人能在本机执行**任意命令**；`allowedUsers` 白名单是唯一门槛，默认只放主人自己。
- `~/.dsh-lark-bot/config.json` 含 larkBin 与白名单（**不含 App Secret**，Secret 在 `~/.lark-cli`），权限 0600，别提交、别贴群。
- App Secret 只经 stdin 传给 `lark-cli profile add`；怀疑泄露就去开放平台重置 Secret 并重跑安装脚本。
- 同一飞书应用**不要在两台机器上同时跑事件消费**（消息事件会被抢）。

---

## 8. 文件

| 路径 | 说明 |
|---|---|
| `bot.mjs` | 主程序（跨平台，零第三方依赖） |
| `config.example.json` | 配置模板（占位符），安装脚本据此生成 `~/.dsh-lark-bot/config.json` |
| `botctl.sh` / `botctl.ps1` | macOS / Windows 管理脚本 |
| `install-windows.ps1` | 上游 Windows 一键安装（保留；本套件未在 Windows 端到端验证） |
| `SOURCE.md` | **来源与改动清单** |
| `docs/本次跑通实录-macOS.md` | 上游跑通记录（已脱敏，历史参考；国内版步骤以 FEISHU-SETUP 为准） |
| `~/.dsh-lark-bot/` | 运行状态、会话映射、日志、`config.json`（保留 7 天日志） |

Windows：`botctl.ps1` 与 `install-windows.ps1` 原样保留，但本套件的安装手册只覆盖 macOS；
Windows 上请先按上游方式装好 DSH/lark-cli，再按 [FEISHU-SETUP](../../docs/FEISHU-SETUP.md) 建应用。
