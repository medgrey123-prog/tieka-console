# 架构：铁卡老弟中控台

## 1. 组件与职责

| 组件 | 跑在哪 | 职责 | 不做什么 |
|---|---|---|---|
| **DSH Desktop** | 你的 Mac | 宿主：面板 UI、观察台插件、Agent 运行时（含 headless 子命令） | 不负责调度/排队/审批（交给 autoloop） |
| **dsh-autoloop-panel** | DSH Host 内（插件） | 中控台面板：卡片审批、runs、花费、Agents 页 | 不改 autoloop 数据，只读接口 + 人点按钮 |
| **dsh-agent-observer** | DSH Host 内（插件） | 读本地会话文件，产出 Claude/Codex/DSH 进度；30 分钟汇报与异常提醒 | 不截图、不 OCR、不控制 GUI |
| **agent-autoloop** | 本机常驻服务（launchd/systemd） | 事件/规则/排队/挂起审批/事实日志/卡片投递 | 不直接连任何外部服务；所有输入都是 HTTP |
| **autoloop worker** | 与中台同进程或独立 | 按规则启动 Agent 进程（dsh/claude/codex），收回执 | — |
| **dsh-lark-bot** | 本机常驻服务（launchd） | 飞书「任务发布机器人」收消息 → `dsh --profile headless` → 结果回飞书 | 不直接调 autoloop 规则（任务由 DSH 执行） |
| **飞书「审阅机器人」** | 飞书开放平台 | 接收 autoloop 卡片（审批/通知/30 分钟汇报） | 不收普通聊天 |
| **飞书「任务发布机器人」** | 飞书开放平台 | 你给它发自然语言任务；它回结果 | 不承载审批卡片 |

## 2. 三条数据流

### A. 任务下派（输入）

```
飞书「任务发布机器人」 ← 你打字
   │ im.message.receive_v1（长连接）
   ▼
dsh-lark-bot（本机 launchd）
   │ 白名单校验 → 同一 chat 复用同一个 DSH session
   ▼
dsh --profile headless --json "你的话"
   ├─ 直接执行（bash/文件/网络/技能）
   ├─ 需要 Claude Code / Codex → 写事件给 autoloop（或直接用 CLI）
   └─ 需要你拍板 → 走 autoloop ask（卡片到审阅机器人）
   ▼
结果回写飞书（进度气泡 + 最终消息）
```

### B. 监控与汇报（输出）

```
每 120 秒：dsh-agent-observer.watchTick()
   ├─ Claude：~/.claude/projects/**/*.jsonl
   ├─ Codex ：~/.codex/sessions/**/rollout-*.jsonl
   └─ DSH   ：~/.dsh/sessions/**/session.v4.jsonl.zstd（多段 zstd 帧）
       │
       ├─ 异常（读不到/掉线/恢复）→ 立即 POST autoloop /v1/tell
       └─ 每 30 分钟 → 汇总 3 个 Agent 当前步骤 + 问题 → /v1/tell
                              │
                              ▼
                     autoloop 通知卡 → 飞书「审阅机器人」
```

### C. 调度与审批（autoloop 闭环）

```
定时 cron / 事件 / 你回答卡片
        │
        ▼
autoloop 内核（规则匹配 → 排队 → 合并）
        │  派活
        ▼
Agent 进程（DSH headless / Claude Code / Codex）
        │  最后一条消息 = 结论 + 可选回执（ask/notice/resolve/later/events）
        ▼
一个事务里生效：卡片 / 复查 / 新事件
        │
        ▼
审阅机器人卡片 → 你点按钮 → 新事件 → 接着原会话干
```

## 3. 文件与端口

| 位置 | 内容 |
|---|---|
| `~/.agent-autoloop/` | `config.json`（中台地址/密钥/worker/通道）、`rules.json`、`master.key`、`hub.db`、`logs/` |
| `~/.dsh-lark-bot/` | `config.json`（larkBin/profile/白名单）、`lark-feishu-task.sh`、`logs/` |
| `~/.lark-cli/` | 两个飞书应用的凭据（keychain）与 profile |
| `~/.cache/dsh-agent-observer/` | `notify.json`（汇报频率/免打扰）、`notify-state.json` |
| `~/.claude/`、`~/.codex/`、`~/.dsh/sessions/` | 观察台只读的数据源 |
| `127.0.0.1:3350` | autoloop 中台（默认） |
| `127.0.0.1:<随机>` | DSH Web GUI（面板/观察台路由） |

## 4. 设计取舍

| 取舍 | 原因 |
|---|---|
| 不打包 autoloop 源码，安装时从上游拉 | 上游 MIT 且更新频繁；我们只抽「用法」：三个 agent + 飞书通道 + 规则模板 |
| 去掉 Grok Bot / Muse / 桌面桥 / agent-desktop | 依赖 macOS 辅助功能+屏幕录制+坐标，跨机器复制不稳定；目标场景只需要 DSH/Claude/Codex |
| 观察台只读会话文件，不截图 | 跨机器零权限依赖；Claude/Codex/DSH 都有稳定的落盘会话 |
| 两个飞书机器人分开 | 审阅（卡片/审批）和任务（聊天指挥）权限与消息模型不同；一个 app 只能有一个 bot |
| 插件走 `plugin_manager` 安装 | DSH 官方扩展点；不手写 profile，升级/卸载可回滚 |
| 所有"需要人拍板"的动作变成卡片 | 对齐 autoloop 设计：一轮不等人，等你时零 token |

## 5. 失败语义（简版）

| 情况 | 行为 |
|---|---|
| Agent 没跑成 | autoloop 指数退避重派（最长 1h），连续 3 次通知你 |
| 任务机器人执行失败 | 飞书回错误摘要；DSH session 可继续 |
| 汇报推送失败 | 观察台下个 tick 重试；不刷屏 |
| 飞书事件没收到 | 机器人长连接断开后自动重连；检查 open.feishu.cn 事件订阅 |
| 中台重启 | SQLite 恢复；卡片/轮次/事实日志都在 |

## 6. 扩展点

- **加规则**：改 `~/.agent-autoloop/rules.json`（模板与字段解释见 `configs/autoloop/`）。
- **加监控对象**：观察台 `lib/agents/` 下加一个 collector（参考 claude.js/codex.js）。
- **加飞书动作**：autoloop 的 source/agent/channel 插件（上游 docs/plugins.md）。
- **加 GUI 自动化**：本套件不含；如确需，另装 agent-desktop + 本地桥，并自行承担权限与稳定性成本。
