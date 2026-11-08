# 飞书双机器人创建与接入手册（国内版 · open.feishu.cn）

本手册讲**在飞书开放平台从零创建两个「企业自建应用」机器人**，然后把它们接到本机：

| 角色 | 应用名（建议） | 干什么 | 本机谁在用它 |
|---|---|---|---|
| **审阅机器人** | `审阅机器人` | 把需要你拍板的事做成**消息卡片**发到飞书；你点按钮回答；周期性收到 Agent 运行汇报 | `agent-autoloop` 的 `channels.feishu` |
| **任务发布机器人** | `任务发布机器人` | 你在飞书给它发一句话，本机 **DSH** 真的执行，进度/结果回到飞书 | `bots/dsh-lark-bot`（launchd 常驻） |

> **只支持国内飞书（open.feishu.cn）**。脚本里固定 `--brand feishu`。
> 国际版（Lark，open.larksuite.com，`--brand lark`）不在本套件范围内，混用会得到
> “app not found / 无权限”之类的错误。
>
> 需要**两个独立应用**（不要用同一个 App 兼任两个机器人）：事件订阅是独占的，消息事件和卡片回调
> 会互相抢；权限与可用范围也应该分开控制。

---

## 0. 开始之前

### 0.1 你需要

| 项 | 说明 |
|---|---|
| 飞书账号 | 能登录 [飞书开放平台](https://open.feishu.cn/app) 的企业成员 |
| 创建应用权限 | 大多数企业要求**管理员或开发者**才能建企业自建应用；没有就找管理员建好，把 App ID / App Secret 给你（Secret 让你自己粘贴，不要走聊天记录） |
| 管理员配合（可能需要） | 应用发布要给管理员审核；可用范围/权限审批也可能需要管理员 |
| 本机环境 | macOS + Node ≥ 20 + `lark-cli` + DSH；autoloop 需要 Node ≥ 24（先跑 `bash bin/env-check.sh`） |

### 0.2 你会用到的两个网址

| 用途 | 地址 |
|---|---|
| 应用列表 / 创建应用 | `https://open.feishu.cn/app` |
| 某个应用的基础信息（把 `<APP_ID>` 换成你的） | `https://open.feishu.cn/app/<APP_ID>/baseinfo` |

### 0.3 本手册的占位符

`<APP_ID>`、`<APP_SECRET>`、`<OPEN_ID>`、`<PROFILE>` 都是要你替换的；仓库里不会出现真实值。

---

## 1. 创建「审阅机器人」

审阅机器人只做两件事：**用应用身份把交互卡片私聊发给你**、**接收你点按钮的回调**。
所以它需要「机器人能力 + 发消息权限 + 卡片回调事件」。

### 1.1 创建企业自建应用

1. 打开 `https://open.feishu.cn/app`，登录后点「创建企业自建应用」。
2. 名称填 **审阅机器人**；描述可填「个人 Agent 中控台审批与汇报」；图标随意（建议深色系，和任务机器人区分）。
3. 创建后进入应用详情页。记下地址栏里的 `<APP_ID>`（`cli_` 开头）。

### 1.2 添加应用能力：机器人

1. 左侧「添加应用能力」→ 找到「机器人」→「添加」。
2. 机器人名称可与应用名一致；消息卡片权限依赖机器人能力，**必须开**。

### 1.3 权限管理（开通 scope）

左侧「权限管理」→ 搜索并开通下面两项（每项都要点「开通」，部分企业需要管理员审批）：

| 权限（scope） | 控制台名称（大致） | 用途 |
|---|---|---|
| `im:message` | 获取与发送单聊、群组消息 | 发送/更新卡片消息的基础权限 |
| `im:message:send_as_bot` | 以应用的身份发消息 | 用机器人身份私聊发卡片给你 |

> 如果控制台还提示需要 `im:message:readonly`、`contact:user.base:readonly` 等，一并开通即可。
> 原则：**以控制台在开通/校验时给出的「必需项」为准**；不确定就多开读取类权限，发送类只开上面两项。
> 权限变更后必须**重新发布版本**才生效（见 1.6）。

### 1.4 事件与回调（长连接，不需要公网 IP）

1. 左侧「事件与回调」→「事件配置」。
2. 订阅方式选 **「使用长连接接收事件」**（不要填请求地址 URL；本机没有公网域名，长连接由本机主动连飞书）。
3. 「添加事件」里搜索并添加：

| 事件 | 说明 |
|---|---|
| `card.action.trigger` | **卡片回传交互**（按钮点击回调）。控制台里可能归类在「回调配置 → 卡片回传交互」，两种入口都行，目标都是订阅这个事件 |

4. 加密策略：长连接模式不需要 Encrypt Key / Verification Token，留空即可。
5. 确认「事件与回调」页里能看到 `card.action.trigger` 已添加。

> 本机侧的消费者由 `agent-autoloop` 启动（`lark-cli event consume card.action.trigger --as bot`），
> 你不需要手跑；但**同一应用同一时间只能有一处消费者**，不要把同一个 App 在第二台机器上再挂一份。

### 1.5 可用范围（谁能用这个机器人）

1. 创建/发布版本时会让你设置「可用范围」（也在应用的「版本管理与发布 → 可用范围」里）。
2. 先选 **「仅自己」** 或指定你自己所在的部门/人员——**必须包含你**，否则你在飞书里找不到这个机器人、也发不了消息。
3. 需要给同事用再扩大到相应范围（建议先只开自己，稳定后再扩）。

### 1.6 创建版本并发布（最容易漏的一步）

**任何能力/权限/事件/机器人名的改动，都要重新创建版本并发布后才生效。**

1. 左侧「版本管理与发布」→「创建版本」。
2. 版本号随便填（如 `1.0.0`）；更新说明写「首次发布」；可用范围选包含你自己。
3. 点「保存」→「申请发布」；如果企业要求审核，等管理员通过。
4. 状态变成「已发布」才算完成。

### 1.7 拿 App ID / App Secret

1. 左侧「凭证与基础信息」。
2. **App ID**：`cli_` 开头，可以复制、不是秘密。
3. **App Secret**：点「查看/重置」复制，**只在重置时完整显示一次**；它等价于应用密码。
   - 不要贴到聊天/文档/仓库；安装脚本只从 stdin 读。
   - 怀疑泄露就「重置」，例如：重置后重跑安装脚本并加 `--force-profile`（同名同 App ID 时脚本默认跳过，不会自动更新 Secret）。

记下：`<审阅机器人APP_ID>`、`<审阅机器人APP_SECRET>`。

### 1.8 把机器人加到你自己的飞书

发布成功后：

1. 打开飞书客户端（手机/桌面）→ 顶部搜索框输入 **审阅机器人** → 找到这个应用/机器人 → 点进去打开会话。
   - 搜不到：确认「已发布」+「可用范围包含你」；企业可能限制在工作台展示，可从「工作台」里找。
2. 私聊里随便发一句话验证它在线（此时接入还没做，机器人可能不回复，但会话/联系人已建立）。

### 1.9 本步验收

- [ ] 应用详情显示：机器人能力已开、`im:message` / `im:message:send_as_bot` 已开通
- [ ] 事件与回调：订阅方式 = 长连接；已添加 `card.action.trigger`
- [ ] 版本状态 = 已发布；可用范围含你
- [ ] 飞书里能搜到并打开「审阅机器人」会话
- [ ] 拿到了 `<审阅机器人APP_ID>` 和 `<审阅机器人APP_SECRET>`

然后按 [INSTALL.md 第 3 步](../INSTALL.md) 用 `feishu/setup-review-bot.sh` 接进本机 autoloop。

---

## 2. 创建「任务发布机器人」

任务发布机器人需要：**机器人能力 + 读你私聊消息的权限 + 发消息权限 + `im.message.receive_v1` 事件**。

### 2.1 创建企业自建应用

1. `https://open.feishu.cn/app` →「创建企业自建应用」。
2. 名称填 **任务发布机器人**，描述如「用飞书遥控本机 DSH 干活」；图标与审阅机器人区分开。
3. 记下新的 `<APP_ID>`（和审阅机器人**不是**同一个）。

### 2.2 添加应用能力：机器人

「添加应用能力」→「机器人」→ 添加。

### 2.3 权限管理

| 权限（scope） | 控制台名称（大致） | 用途 |
|---|---|---|
| `im:message.p2p_msg:readonly` | 读取用户发给机器人的单聊消息 | 接收你私聊发给机器人消息的事件内容（控制台若显示为 `im:message:readonly` 等「读取消息」权限，同样开通） |
| `im:message:send_as_bot` | 以应用的身份发消息 | 机器人回复你、发送进度与结果 |
| `im:message` | 获取与发送单聊、群组消息 | 发送/编辑消息的基础权限（通常和上面一起要） |

> 同样以控制台提示的「必需项」为准；只做私聊即可，不需要群相关权限（除非你打算用群聊，
> 那才需要群消息读取权限并在 bot 配置里开 `allowGroups`）。

### 2.4 事件与回调（长连接）

1. 「事件与回调」→「事件配置」→ 订阅方式选 **「使用长连接接收事件」**。
2. 添加事件：

| 事件 | 说明 |
|---|---|
| `im.message.receive_v1` | **接收消息**（你发给机器人的私聊消息） |

3. 加密策略留空。确认事件列表里能看到 `im.message.receive_v1`。

### 2.5 可用范围

和审阅机器人一样：**必须包含你**；建议先只开自己。

### 2.6 创建版本并发布

「版本管理与发布」→ 创建版本 → 填写 → 申请发布 → 管理员通过 → 已发布。
注意：**权限和事件都在发布后才生效**，这是“机器人不回消息”的第一大原因。

### 2.7 拿 App ID / App Secret

「凭证与基础信息」→ 复制 `<任务发布机器人APP_ID>` 和 `<任务发布机器人APP_SECRET>`。

### 2.8 把机器人加到你自己的飞书

发布后在飞书搜索「任务发布机器人」→ 打开会话 → 发一句话（如「你好」）。

- 此时还没装白名单，正常会收到 **「⛔ 未授权 … 你的 open_id：`ou_...`」**——这是设计好的引导流程，
  把这个 `ou_...` 记下来，装脚本时传给 `--owner`。
- 如果连「未授权」都不回：说明事件没订阅 / 订阅方式不是长连接 / 版本没发布 / 可用范围不含你 / 权限没审批，
  逐项对照第 4 节。

### 2.9 本步验收

- [ ] 机器人能力已开；读取私聊消息 + 发消息权限已开通
- [ ] 事件：长连接 + `im.message.receive_v1`
- [ ] 版本已发布；可用范围含你
- [ ] 飞书里能给「任务发布机器人」发消息（并收到「未授权 + open_id」回复）
- [ ] 拿到了 `<任务发布机器人APP_ID>` / `<任务发布机器人APP_SECRET>`

然后按 [INSTALL.md 第 6 步](../INSTALL.md) 用 `feishu/setup-task-bot.sh` 接进本机。

---

## 3. 两个机器人的命名、头像与描述

| 项 | 建议 |
|---|---|
| 名称 | `审阅机器人` / `任务发布机器人`（名称发布后可在「基础信息」改，改完要重新发布；App ID 不变） |
| 头像 | 两个用不同颜色/图标，飞书会话列表里一眼能分清 |
| 描述 | 审阅：「Agent 审批与汇报（卡片）」；任务：「给本机 DSH 派活」 |
| 机器人问候语 | 可留空；任务机器人首次收到消息会自动回「⛔ 未授权 + open_id」 |

---

## 4. 常见失败与修复（对照表）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 飞书发消息，机器人完全不回 | **事件没订阅** `im.message.receive_v1`；或订阅方式不是长连接 | 1.4；改完**重新创建版本并发布** |
| 2 | 同上；后台显示「未发布/审核中」 | **应用未发布**或管理员没审批 | 等审核通过；或让管理员发布 |
| 3 | 飞书里搜不到机器人 / 发不出消息 | **可用范围不含本人** | 1.5 / 2.5，把范围改成包含你并重新发布 |
| 4 | 调用接口报 `permission denied` / 无权限 | **权限未开通或未审批**；或开了权限但没发新版本 | 1.3 / 2.3；开权限 → **重新发布版本** |
| 5 | 机器人已发布但「机器人能力」没开 | 应用没有机器人能力，消息卡片/收发都不成立 | 「添加应用能力 → 机器人」→ 重新发布 |
| 6 | 审阅机器人卡片收不到 | `im:message:send_as_bot` 未开通；或 `~/.agent-autoloop/config.json` 的 `channels.feishu` 没生效 | 检查权限；`bash feishu/setup-review-bot.sh ... --owner <OPEN_ID>` 后**重启中台** |
| 7 | 卡片能收到，点按钮没反应 | **`card.action.trigger` 没订阅**；或 `rules.json` 的 `channels.feishu.answerers` 不是你的 open_id（且必须是**审阅应用**下的 open_id） | 1.4；重跑 `feishu/setup-review-bot.sh --profile tieka-review --owner <OPEN_ID>` |
| 8 | 任务机器人回「⛔ 未授权」 | 正常引导流程：你的 open_id 不在白名单 | 用回复里的 open_id 重跑 `feishu/setup-task-bot.sh --profile tieka-task --owner ou_...` |
| 9 | `event consume` 报 app/brand 不匹配 | profile 建成了国际版（`--brand lark`）或 App ID 填错 | 重建 profile：加 `--force-profile` 重跑安装脚本 |
| 10 | 两个机器人只有一个能用 | 两个角色共用了同一个应用（事件订阅互相抢） | 按本手册建**两个独立应用** |
| 11 | 长连接报「已有消费者」/ 事件时有时无 | 同一个应用在另一台机器/另一个进程里也在消费 | 停掉多余的 consumer（本机 `lark-cli event status`） |
| 12 | 重置过 App Secret 后机器人失灵 | 本地 profile 还是旧 Secret | 重跑安装脚本并加 `--force-profile` |
| 13 | `agent-autoloop status` 里审阅通道离线 | wrapper 不存在/不可执行、profile 过期、配置没重启 | 重跑 `feishu/setup-review-bot.sh --profile tieka-review --owner <OPEN_ID>`；`agent-autoloop service install` 重启；看 `~/.agent-autoloop/logs/up.log` |
| 14 | 任务 bot launchd 起不来 | Node 路径/权限/plist 问题 | `bash bots/dsh-lark-bot/botctl.sh status`；看 `~/.dsh-lark-bot/logs/launchd.err.log` |

---

## 5. 国内版 vs 国际版

| 项 | 国内飞书（本套件） | 国际版 Lark（不支持） |
|---|---|---|
| 开放平台 | `open.feishu.cn/app` | `open.larksuite.com/app` |
| lark-cli | `--brand feishu`（脚本已固定） | `--brand lark` |
| 本套件脚本 | ✅ | ❌ 会连错环境 |

如果你的企业用的是国际版 Lark，本套件**不能直接改个参数用**：创建应用、权限名、事件名相近但不通用，
需要另行适配 `feishu/setup-*.sh` 里的 `--brand` 与开放平台地址。

---

## 6. 安全与凭据

- **App Secret = 应用密码**。只在「凭证与基础信息」重置时看到一次；不要贴聊天、不要进仓库、不要写进
  `config.json`（本套件只把它交给 `lark-cli profile add --app-secret-stdin`，由 lark-cli 存在本机凭据里）。
- 权限最小化：只开本手册列的权限；不要一上来开通讯录/文档/审批全量权限。
- 可用范围最小化：先「仅自己」，确认稳定再扩大。
- 两个应用各自独立凭据；不要交换 App ID/Secret。
- 任务发布机器人能让本机 DSH **执行任意命令**（以你的用户权限）；白名单（`allowedUsers`）是唯一门槛，
  只加你信任的人。
- 本机敏感文件：`~/.lark-cli`（profile/凭据）、`~/.agent-autoloop/{config.json,master.key}`、
  `~/.dsh-lark-bot/config.json`；权限 0600/0700，不要提交、不要贴群。
- 网络安全：只需**出站**访问 `open.feishu.cn`（HTTPS/WebSocket），不需要公网 IP、域名、证书、端口映射。

---

## 7. 装到本机（脚本调用速查）

```bash
# —— 审阅机器人 ——
# 第一次：扫码拿 open_id（会打印 OPEN_ID=ou_xxx）
#   交互运行时脚本会提示粘贴 App Secret；非交互/脚本方式用下面的 stdin 写法
bash feishu/setup-review-bot.sh --profile tieka-review --app-id <APP_ID> --login \
  < <(printf '%s' '<APP_SECRET>')
# 第二次：接进 autoloop（Secret 走 stdin）
bash feishu/setup-review-bot.sh --profile tieka-review --app-id <APP_ID> --owner <OPEN_ID> \
  < <(printf '%s' '<APP_SECRET>')
# 改完 config.json 必须重启中台：
launchctl kickstart -k gui/$(id -u)/agent-autoloop   # 或 agent-autoloop service install

# —— 任务发布机器人 ——
# 第一次：装 profile/wrapper/config/launchd（还没有白名单）
bash feishu/setup-task-bot.sh --profile tieka-task --app-id <APP_ID> \
  < <(printf '%s' '<APP_SECRET>')
# 去飞书给它发一句话 → 拿回复里的 open_id → 重跑（不用再给 Secret）：
bash feishu/setup-task-bot.sh --profile tieka-task --owner <OPEN_ID>
```

两个脚本都支持 `--dry-run`（只打印计划），也都可以重复运行。
细节见 [feishu/README.md](../feishu/README.md)。

> 首次创建 lark-cli profile 时，macOS 可能弹出「钥匙串/凭据访问」授权框：这是 lark-cli 在安全保存 App Secret，
> 点「允许」即可。只有在需要重建 profile（`--force-profile`）或换 App 时才会再问。

---

## 8. 验收清单

| # | 检查 | 命令 / 方式 | 预期 |
|---|---|---|---|
| 1 | 两个应用已发布、可用范围含你 | 开放平台「版本管理与发布」 | 状态「已发布」 |
| 2 | lark-cli 里两个 profile | `lark-cli profile list` | 有 `tieka-review`、`tieka-task` |
| 3 | 审阅机器人 bot 身份可用 | `lark-cli --profile tieka-review auth status --json` | `identities.bot.status = ready` |
| 4 | 审阅事件入口就绪 | `lark-cli --profile tieka-review event consume card.action.trigger --as bot --dry-run` | 预检通过，不真正启动 |
| 5 | autoloop 通道在线 | `agent-autoloop status` | 通道里「审阅机器人」在线（重启后） |
| 6 | 卡片真能到飞书 | `printf '通道自测\n' \| agent-autoloop tell tieka-feishu-test` | 飞书收到通知卡 |
| 7 | 任务机器人事件监听 | `lark-cli event status` | 任务 profile 有 `im.message.receive_v1` consumer |
| 8 | 任务机器人自检 | `bash bots/dsh-lark-bot/botctl.sh doctor` | 必需项全绿 |
| 9 | 任务机器人回话 | 飞书发 `/ping` | 回 `🏓 pong` |
| 10 | 任务机器人真执行 | 飞书发「回我一句安装成功」 | 真的执行并回结果 |

---

## 9. 卸载 / 回滚

```bash
# 任务发布机器人
bash bots/dsh-lark-bot/botctl.sh stop
bash bots/dsh-lark-bot/botctl.sh uninstall
lark-cli profile remove tieka-task            # 收回本地凭据

# 审阅机器人（通道）
agent-autoloop key remove channel feishu      # 收回通道密钥
# 有 .bak-tieka-* 备份就 cp 回去；然后重启中台
launchctl kickstart -k gui/$(id -u)/agent-autoloop
lark-cli profile remove tieka-review

# 飞书侧：开放平台 → 应用 → 版本管理与发布 → 停用/删除应用；机器人会随应用一起消失
```

---

## 附录 A · lark-cli 速查

```bash
lark-cli profile add --name <PROFILE> --app-id <APP_ID> --app-secret-stdin --brand feishu
lark-cli profile list
lark-cli profile remove <PROFILE>
lark-cli --profile <PROFILE> auth login --domain im            # 扫码/浏览器授权（要 user 身份时）
lark-cli --profile <PROFILE> auth login --no-wait --json       # 非交互：先拿 URL，稍后用 --device-code 完成
lark-cli --profile <PROFILE> auth status --json                # 看 bot/user 身份与 user openId
lark-cli --profile <PROFILE> event consume <EventKey> --as bot --dry-run   # 只预检，不真连
lark-cli doctor
```

## 附录 B · 两个应用配置清单（对照用）

| 配置项 | 审阅机器人 | 任务发布机器人 |
|---|---|---|
| 应用类型 | 企业自建应用 | 企业自建应用 |
| 机器人能力 | ✅ | ✅ |
| 权限 | `im:message`、`im:message:send_as_bot` | `im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:message` |
| 事件 | `card.action.trigger` | `im.message.receive_v1` |
| 订阅方式 | 长连接 | 长连接 |
| 可用范围 | 含你 | 含你 |
| 发布 | ✅ 已发布 | ✅ 已发布 |
| 本机接入 | `feishu/setup-review-bot.sh` | `feishu/setup-task-bot.sh` |

## 附录 C · FAQ

**Q：必须用企业自建应用吗？商店应用行不行？**
A：本套件按企业自建应用写（自己能控制权限/发布/可用范围）。商店应用要走上架审核，不适合个人机器。

**Q：没有管理员权限怎么办？**
A：找管理员：① 帮你创建两个企业自建应用并把 App ID/Secret 给你；② 帮你审批权限与版本发布；
③ 把可用范围加上你。其余步骤都能自己做。

**Q：可以用一个应用同时当两个机器人吗？**
A：不建议也不支持：事件订阅（消息事件 vs 卡片回调）与可用范围会互相干扰，且本机两个消费者会抢同一个应用的
长连接。请建两个应用。

**Q：改了机器人名字/权限，要做什么？**
A：改完**创建新版本并发布**，否则不生效。

**Q：App Secret 忘了/泄露了？**
A：开放平台「凭证与基础信息 → 重置 App Secret」，然后重跑对应安装脚本并加 `--force-profile`。
