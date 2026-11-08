# 安全边界

本套件是「**单机、单用户**」的个人中控台，不是多租户服务。下面列出它会碰到的凭据、权限与风险，装之前请确认你接受。

## 1. 凭据清单（全部只存在本机）

| 凭据 | 位置 | 保护 |
|---|---|---|
| 两个飞书 App Secret | macOS keychain / lark-cli 配置（`~/.lark-cli`） | lark-cli 管理；不要贴到聊天、不要提交 |
| lark-cli 的 app/user token | `~/.lark-cli`（keychain） | 同上 |
| autoloop 的 owner/worker/source/channel key | `~/.agent-autoloop/config.json`（0600） | 只本机可读 |
| autoloop `master.key` | `~/.agent-autoloop/master.key`（0600） | 用于推导轮次/卡片 token；备份时与 `hub.db` 一起保管 |
| 任务机器人配置 | `~/.dsh-lark-bot/config.json` | 含 larkBin 与白名单，不含 App Secret |
| DSH 自身凭据 | DSH 管理 | 本套件不读取 |

**仓库里只有占位符**：`<APP_ID>`、`<OPEN_ID>`、`$HOME/...`，没有真实密钥。

## 2. 机器人权限与白名单

- **任务发布机器人**：只允许白名单里的 open_id 指挥；别人发消息会被忽略（首次会回一条"未授权+你的 open_id"，用于引导你自己加白名单）。
- **审阅机器人**：`rules.json` 的 `channels.feishu.answerers` 只包含你；别人拿到卡片也点不了（`by` 要匹配）。
- 建议两个机器人**只加自己**，不要拉群（`allowGroups` 默认 false）。

## 3. 执行权限

- 任务发布机器人会把你的话原样交给 `dsh --profile headless` **在本机执行**（你的用户权限）：不要把它当成"云沙箱"。
- autoloop agent 的 `access` 只翻译成各 CLI 的权限参数（Claude `edit`、Codex `read`），不是系统沙箱；要强隔离请用系统账号或容器。
- `askFirst`（删数据/停服/花钱/对外发消息）建议保留，让危险动作走卡片审批。

## 4. 网络暴露面

- autoloop 默认只听 `127.0.0.1:3350`，**不要**把端口暴露到公网；需要远程批卡请走飞书，或自己加 HTTPS 反代并加固。
- DSH Web GUI 也是本机回环地址；插件注册的路由（`/autoloop/*`、`/agents/*`）只在同一 DSH 端口内可访问。
- 任务/审阅机器人靠飞书**长连接**接入，本机不需要开放端口、不需要公网 IP。

## 5. 提示注入与数据边界

- autoloop 的设计：事件里的外部文字只作为"资料"写进 `context.json`，不进入提示词；决定交给谁/在哪/什么权限只由本机规则决定。
- 任务机器人收到的飞书消息会直接成为 DSH 提示词的一部分——只把机器人给自己/信任的人；不要让它读不可信公开群的消息。
- 观察台只读本机会话文件，不联网；它生成的汇总是本机数据，经 autoloop 卡片发到飞书。

## 6. 安装期安全

- `plugin_manager install_bundle` 需要 Full access/审批；只安装本仓库 `plugins/` 下的两个本地包，不要装来源不明的 bundle。
- 脚本会写 `~/.agent-autoloop`、`~/.dsh-lark-bot`、`~/.lark-cli`，并注册两个 launchd 服务；卸载见 INSTALL 第 8 步。
- 不要 `git add` 你的 `~/.agent-autoloop/config.json`、`~/.dsh-lark-bot/config.json`、任何 `*.bak-*`。

## 7. 已知风险（诚实清单）

- 任务机器人是"以你身份在本机执行自然语言"——模型可能误解指令；对不可逆操作请依赖 `askFirst` 审批。
- 观察台读到的是落盘会话，不是实时内存；刚发生的一步可能晚几秒。
- autoloop 是"至少一次"系统：Agent 可能被叫两次，有副作用的操作要在 Skill 里先核实当前状态。
- lark-cli / 飞书开放平台接口变更可能需要升级 `@larksuite/cli`。
