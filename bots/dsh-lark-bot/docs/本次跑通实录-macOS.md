# 本次跑通实录（macOS 原始环境）

> 这份文档记录 **2026-10-23 在 macOS 上从零把「Lark 消息 → DeepSeek Harness」打通**的完整过程、每个技术决策的理由、实测证据和踩过的坑。
>
> 用途：① 复盘为什么这么设计；② 换任何平台（Windows/Linux）移植时对照差异；③ 出问题时知道该看哪一层。

> **历史文档 / 已脱敏**：这是上游插件第一次在 macOS 上跑通的原始记录，当时用的是**国际版 Lark**（`brand=lark`、`open.larksuite.com`）。
> 本套件目标环境是**国内飞书 open.feishu.cn**：创建应用、权限、事件、发布步骤一律以 [../../../docs/FEISHU-SETUP.md](../../../docs/FEISHU-SETUP.md) 为准；
> 文中出现的 `--brand lark` 请换成 `--brand feishu`、`open.larksuite.com` 请换成 `open.feishu.cn`。
> 消息 / 会话 / open_id 已替换为占位符。

---

## 1. 最终形态

```
 Lark App（手机/桌面）
      │ 用户发消息
      ▼
 im.message.receive_v1
      │ WebSocket 长连接（lark-cli 主动外连）
      ▼
 bot.mjs（常驻，launchd / 计划任务托管）
      ├─ 白名单 / 去重 / 过期消息拦截 / 斜杠命令
      ├─ chat_id ↔ DSH session 映射（上下文连续）
      └─ dsh --profile headless --json "<消息>"
             ├─ 进度事件 → 实时编辑 ack 气泡
             └─ final → 编辑进同一气泡 / 长文分片
```

代码：`bot.mjs`（约 1100 行，零第三方依赖，只用 Node 内置模块）
托管：macOS `launchd`（Windows 对应计划任务 + VBS 看门狗）

---

## 2. 时间线与验证顺序

| 阶段 | 做的事 | 结果 |
|------|--------|------|
| ① 可行性侦察 | 查 `lark-cli` 版本/登录态、`dsh --help` | lark-cli 1.0.98 已登录**国际版**（brand=lark），bot+user 身份 ready；DSH 有 `headless` profile |
| ② 事件通道实测 | 后台起 `lark-cli event consume im.message.receive_v1`，从用户身份发测试消息 | WebSocket `connected`；捕获到真实事件 |
| ③ 确认事件载荷 | 读 `event schema` + 实际捕获 | 扁平结构，`content` 已渲染成纯文本，`sender_id` 是 open_id |
| ④ 确认执行入口 | `dsh --profile headless --json "..."` | NDJSON 事件流：`session` / `status` / `tool_call` / `tool_result` / `text` / `final`，**带 sessionId** |
| ⑤ 写 bot.mjs | 事件消费 + 队列 + 会话映射 + 进度回写 | — |
| ⑥ 端到端自测 | `node bot.mjs --simulate "建个文件…"` | 7 秒完成：Lark 里 ack 气泡被编辑成「✅ 完成 · 7s」，`/tmp/lark-bot-test.txt` 真被创建 |
| ⑦ 常驻化 | launchd + 开机自启 + 崩溃重启 | `state = running`，WebSocket 就绪 |
| ⑧ 真实使用 | 用户实际发了 3 个任务 | 全部成功（见 §5） |
| ⑨ 跨平台重构 | 加 Windows 支持 + `--doctor` + `--init` | 原生二进制直连，单次调用 30ms |

---

## 3. 每个技术决策的理由

### 3.1 为什么用 `lark-cli event consume` 长连接，而不是 Webhook
- Webhook 需要公网 HTTPS 域名 + 证书 + 内网穿透，个人电脑上维护成本高
- Lark 官方支持长连接（WebSocket）订阅方式，电脑主动外连，NAT/公司网络都能用
- `lark-cli` 已封装好：`event consume <EventKey>` 输出 NDJSON，直接给程序消费

**代价**：必须保证 stdin 不 EOF（unbounded 模式下 stdin 关闭 = 优雅退出），所以 bot 里始终持有子进程 stdin。**这是移植时最容易踩的坑。**

### 3.2 为什么用 `dsh --profile headless --json` 子进程，而不是调 API
- 复用完整的 DSH 能力：工具、技能、MCP、沙箱、审批策略，等价于 GUI 里开一个会话
- `--json` 给出结构化事件流：可以拿 `sessionId` 续接上下文、拿 `tool_call` 做进度展示
- 每个 Lark 会话一个独立 DSH 进程，任务隔离、可超时、可 kill

### 3.3 为什么"编辑同一条消息"而不是每条进度发新消息
- Lark 里刷屏体验极差
- 编辑 API（`im +messages-edit`）有 30 分钟/2 次更新等限制（不同版本有别），所以做了限频：默认 8 秒一次、单条最多 40 次
- 完成后直接把 ack 气泡编辑成最终答案，一进一出只占一条气泡

### 3.4 为什么会话映射到 `chat_id` 而不是 message
- 同一聊天里连续追问是最自然的用法
- `--session-id` 指向不存在的 session 会报错 → 代码里有"失败后自动重开新会话"的兜底

### 3.5 为什么白名单是硬门槛
- 机器人能在电脑上执行**任意命令**
- 默认 `allowedUsers` 只放主人自己；未授权用户发消息会收到自己的 open_id 提示（方便你决定要不要加）

### 3.6 为什么 lark-cli 走原生二进制
- `lark-cli` 是 Go 二进制 + npm JS 启动器（`scripts/run.js` 再 spawn 原生 exe）
- 直接 spawn 原生二进制：单次调用从 ~250ms 降到 ~30ms
- 进度回写是高频操作，这个优化很值钱

---

## 4. 实测证据（原始输出）

**事件载荷**（用户真实发了一个「？」）：

```json
{"type":"im.message.receive_v1","event_id":"<EVENT_ID>","message_id":"<MESSAGE_ID>",
 "chat_id":"<CHAT_ID>","chat_type":"p2p","message_type":"text",
 "sender_id":"<OPEN_ID>","sender_type":"user","content":"？"}
```

**DSH headless 事件流**：

```json
{"type":"session","sessionId":"<SESSION_ID>","cwd":"<CWD>"}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"tool_call","callId":"call_...","tool":"bash","input":{"command":"echo bot-test"}}
{"type":"tool_result","callId":"call_...","status":"completed","result":"bot-test\n"}
{"type":"text","text":"执行完成，输出结果是…"}
{"type":"final","text":"执行完成，输出结果是…"}
```

**端到端自测日志**：

```
[simulate] 走完整链路：在 /tmp 下创建文件 lark-bot-test.txt…
收到消息 chat=<CHAT_ID> len=53
会话映射 chat=<CHAT_ID> → <SESSION_ID>
任务结束 ok=true code=0 dur=7s steps=2 answerChars=64 tool=bash
```

---

## 5. 真实使用记录（部署后 1 小时内）

| 时间 | 用户消息 | 结果 |
|------|----------|------|
| 17:20 | 「查一下我的 maxsiumuwatch-v3 那个多维表格，看我和阿生这个供应商的交易情况」 | ✅ 24 步、97 秒、2728 字答复 |
| 17:38 | 「我欠微微钱吗」 | ✅ 8 步、55 秒、1284 字答复 |
| 17:03 | `/status` | ✅ 命令链路正常 |

> 期间出现 2 次 `429 rate_limit`（Lark token 接口限流），进度编辑失败但**结果照常送达**——因为 `editOrSend()` 失败会回退成新消息发送。之后加了 stderr JSON 解析 + 指数退避重试。

---

## 6. 踩过的坑（移植前必读）

| # | 坑 | 现象 | 解决 |
|---|----|------|------|
| 1 | 用户身份缺 `im:message` scope | 以 user 身份发消息报 `missing_scope` | 机器人**一律用 bot 身份**发消息（`--as bot`），只需要 App 权限 |
| 2 | unbounded 消费进程 stdin EOF 会退出 | 后台跑几秒就死 | 持有 stdin 不关闭；或加 `--timeout` |
| 3 | 多个 consumer 抢 bus | `another bus already connected` | 单实例锁（pid 文件）+ 启动前清理残留 |
| 4 | Lark 接口 429 限流 | 进度更新偶发失败 | 错误信息常在 **stderr**，要两处都解析；指数退避；进度间隔≥8s |
| 5 | 进度刷屏 | 体验差、也更容易限流 | 编辑同一条消息 + 限频 |
| 6 | `--session-id` 不存在直接报错 | 重启/换机器后任务失败 | 检测到失败自动重开新会话并告知用户 |
| 7 | 进程组 kill 平台差异 | Windows 上 `process.kill(-pid)` 无效 | Windows 用 `taskkill /PID <pid> /T /F` |
| 8 | npm 全局 bin 在 Windows 是 `.cmd`，Node spawn 会 EINVAL | 直接 spawn 失败 | 走原生 `.exe`；DSH 用 `process.execPath + lib/bin.js` |
| 9 | 老消息在重启后被处理 | 误执行很久以前的指令 | `maxMessageAgeMs` 默认 15 分钟 |
| 10 | 测试消息与真实消息混淆 | 自测污染上下文 | `--simulate` 使用独立 message_id；`/new` 可重置 |

---

## 7. 与 Windows 手册的对应关系

| 能力 | macOS（本文） | Windows（上游 `install-windows.ps1`，本套件未验证） |
|------|---------------|--------------------------------------|
| 托管 | launchd plist | 计划任务 + `run-hidden.vbs` 看门狗 |
| 管理 | `botctl.sh` | `botctl.ps1` |
| 进程树 kill | `process.kill(-pid)` | `taskkill /T /F` |
| 路径 | `~/.dsh-lark-bot` | `%USERPROFILE%\.dsh-lark-bot` |
| 二进制 | `.../bin/lark-cli` | `.../bin/lark-cli.exe` |
| 环境自检 | `./botctl.sh doctor` | `.\botctl.ps1 doctor` |

**代码是同一份**，平台差异都在 `bot.mjs` 里通过 `process.platform` 分支处理（`IS_WIN`）。

---

## 8. 后续可做的增强（未实现）

- 群聊 @ 机器人（代码有 `allowGroups` 开关，但群聊里还没做 @ 判断）
- 图片/文件消息（现在只处理文本，其他类型会友好提示）
- 交互卡片按钮（例如「停止任务」「查看完整日志」）
- 多机部署（每个 Lark 会话路由到不同电脑）
- 流式 token 级输出（现在按 8 秒快照刷新）
