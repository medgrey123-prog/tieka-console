# Agent 观察台 lite（dsh-agent-observer）

DSH **Host-only** 插件：只读本机 **Claude / Codex / DSH** 三个 CLI Agent 的会话文件，回答「它们各自干到哪一步」；
对外暴露 `/agents/*` 同源路由（给**铁卡老弟面板**的 Agents tab 取数），注册一个只读工具 `agents_status`，
并经本机 agent-autoloop 中台推飞书：**异常即时提醒 + 每 30 分钟运行汇报**。

这是「lite 版」：**没有 GUI Agent，没有截图、没有 OCR、没有窗口列表**。
Grok Bot / Muse 的窗口采集、`bin/winlist`、`bin/ocr`（含 Swift 源码）与 `/agents/:id/snapshot*` 路由都已整体移除，
换成「纯文件采集」——任何机器只要有 `~/.claude`、`~/.codex`、`~/.dsh` 就能跑，不需要屏幕录制权限。

| Agent | 数据来源 | 采集方式 |
| --- | --- | --- |
| Claude | `~/.claude/projects/<bucket>/<session>.jsonl` | 只读文件尾部 |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 只读头 + 尾部 |
| DSH | `~/.dsh/sessions/<bucket>/<session>/session.v4.jsonl.zstd` | 多段 zstd 解帧后只读尾部 |

读取链路全部走本地文件，**零第三方依赖**（只用 `node:` 内置模块），只读，不写 DSH profile。
唯一的网络行为是「[飞书提醒](#飞书提醒)」：POST 本机中台 `127.0.0.1:3350/v1/tell`，
由中台经飞书 + 桌面通知推卡片；每条都带 3 个 Agent 的现状与问题小节。可在配置里关闭，关掉后彻底零网络。

## 目录

```
dsh-agent-observer/
├─ package.json          # @local/dsh-agent-observer，dsh.bundle.patch 指向 cordis.patch.yml
├─ cordis.patch.yml      # insert: {id: agent-observer, name: '@local/dsh-agent-observer', config: {}}
├─ icon.svg              # 雷达 + 3 个 agent 圆点
├─ locale/{zh,en}.json   # meta 标题/描述（Agent 观察台 lite / Agent Observer lite）
├─ lib/index.js          # Host 入口：/agents/* 路由 + agents_status 工具 + 提醒后台循环
├─ lib/notify.js         # 飞书提醒：/v1/tell 推送、异常判定、30 分钟汇报、免打扰、状态文件
├─ lib/util.js           # JSONL/尾部读取、多段 zstd 解压、截断、状态阈值
├─ lib/agents/index.js   # 采集编排（每个 agent 独立 try/catch）
├─ lib/agents/claude.js  # Claude 会话选择与解析
├─ lib/agents/codex.js   # Codex rollout 解析
├─ lib/agents/dsh.js     # DSH 多段 zstd 会话解析
└─ lib/agents/selftest.mjs
```

安装（由宿主/profile 管理员执行，本插件自身不执行）：见 [../README.md](../README.md)。
用目标 DSH 的 `plugin_manager` 指到本目录：

```text
plugin_manager({ action: "install_bundle", target: "<repo绝对路径>/plugins/dsh-agent-observer" })
```

返回 `application: applied` 后**刷新 DSH 页面**（Cmd+R），必要时重启一次 DSH。
不需要屏幕录制/辅助功能权限；不需要中台也能跑（只是飞书提醒自动降级）。

## HTTP 路由

所有路由挂在 DSH 自带 HTTP server 上（同源，Client 直接 `fetch('/agents/...')`），统一 `cache-control: no-store`。

> 注意：DSH `webServer` 的 prefix 匹配规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`，
> 所以前缀注册必须写 `path: '/agents'`（**不要带尾斜杠**，否则 `/agents/dsh/steps` 永远 404）。

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/agents/summary` | `{ok:true,data:{generatedAt,agents:[...]}}`，目标 <500ms |
| GET | `/agents/:id/steps?limit=20` | `{ok:true,data:{agent:{id,name},steps:[{at,role,text,meta?}]}}`，text ≤600 字，最新在后 |
| GET | `/agents/notify/state` | 提醒配置 + 上次 tick 状态 + 最近推送 + 汇报计划（只读） |
| POST | `/agents/notify/test` | 真发一条测试 tell；`DRY_RUN=1` 时 `{dryRun:true,sent:false}` 不真发 |
| POST | `/agents/notify/report` | 立即发一条完整周期汇报（忽略免打扰，真实验证入口） |

- `:id` 取值只有 `claude | codex | dsh`；`notify` 是固定调试前缀，不是 agent id。
- 业务错误也是 HTTP 200：`{ok:false,error:{code,message}}`；未知 id → `code:'UNKNOWN_AGENT'`。
- 方法不对 → HTTP 405 `code:'METHOD'`；不认识的子路径 → 404 `code:'NOT_FOUND'`。
- **没有** `/agents/:id/snapshot`、`/agents/:id/snapshot.png`（lite 不截图）；请求它们会得到 404 `NOT_FOUND`。
- 提醒配置缺失/中台没装时，`/agents/notify/state` 仍返回 200，用 `hub:{configured:false,error:{code}}` 表达降级。

`summary.agents[]` 每项字段（lite 契约，不含 `window` / `snapshotAt` / `outputs`）：

```
{ id, name, kind:'code', running, status:'working'|'idle'|'offline'|'error',
  lastActivityAt, ageSec, session:{id,title,cwd,model}|null, step, detail }
```

## 只读工具 `agents_status`

- 参数：`detail:'summary'|'full'`（默认 summary）、`agent?: 'claude'|'codex'|'dsh'`。
- 返回 `{summary: string}`，中文一行一个 agent：
  `Claude：idle，18 分钟前，会话「手表 copy」，最近：…`；`full` 额外带最近几步（role：text）。
- 纯只读：没有回答、审批、控制类动作。

## 各数据源解析要点

### Claude（`~/.claude/projects`）

- 每行一个 JSON 事件；`type` 有 `user` / `assistant` / `custom-title` / `agent-name` / `attachment` / `system` 等。
- `message.content` 可能是字符串或内容块数组（`text` / `tool_use` / `tool_result` / `thinking`）。
- **会话选择两步**：先按文件 mtime 取最近 12 个候选；再读每个候选尾部 64KB，按「最后一条 user/assistant
  消息时间」挑真正在干活的那个，并跳过 `entrypoint` 以 `sdk-` 开头的后台 SDK 会话（如 claude-mem 观察器）。
  避免「应用打开过、但内容几周没动」的会话冒充当前进度。
- `lastActivityAt` 用最后一条消息时间（没有消息才退回文件 mtime）。
- 标题优先级：`custom-title` > `agent-name` > 首条用户消息 > cwd 目录名。
- 文件可能几 MB：小文件整读；大文件读头 128KB（标题/model/cwd）+ 尾部 2MB（最近步骤）。

### Codex（`~/.codex/sessions`）

- 每行 `{timestamp,type,payload}`；关注 `session_meta`（cwd/id/originator）、
  `response_item + message`（role `user`/`assistant`，content 块 `input_text`/`output_text`/`text`）、
  `response_item + function_call/custom_tool_call`（工具调用）、`event_msg + task_complete`
  （`last_agent_message`）、`turn_context`（最新 cwd/model）。
- rollout 文件可能几十 MB：一律只读头 64KB + 尾部 768KB（摘要）/ 2MB（步骤）。
- 标题取 cwd 目录名；`ageSec` 用文件 mtime（与最后一个事件时间基本一致）。

### DSH（`~/.dsh/sessions`）

- `session.v4.jsonl.zstd`（兼容 v3 / 无版本）是**多段独立 zstd 帧首尾拼接**，不是单个 zstd stream。
  按 magic `28 b5 2f fd` 切帧，逐帧 `zlib.zstdDecompressSync` 后拼回 JSONL；坏帧/截断帧跳过。
- 事件 `{type,seq,time,data}`，用 `seq` 去重排序后取：`user/message`、`assistant/message`
  （`text` 块；工具轮里只有 `reasoning` 块时，把最近一段 reasoning 当 assistant 步骤）、
  `tool/call`、`session/title`、`request/header`（model）。
- **主会话优先**：跳过 `origin:'subagent'` 的会话，优先取用户直接开的主会话；
  状态/ageSec 取所有 DSH 会话里最新的写入（子 agent 也在代表 DSH 干活），
  `detail` 里标注并行子会话数量。

## 状态语义

| 字段 | 含义 |
| --- | --- |
| `running` | Claude/Codex：120 秒内有新活动；DSH 恒为 `true`（宿主就是 DSH） |
| `working` | 最近 180 秒内有真实活动 |
| `idle` | 24 小时内有活动 |
| `offline` | 24 小时内无活动（只是没人用，不算异常） |
| `error` | 该 agent 采集抛错（`detail` 写原因），不影响其他 agent |

每个 agent 独立 try/catch：单个数据源坏掉只会让那一行 `status:'error'`，其余照常。

## 飞书提醒

两类推送，都走「插件后台 120s tick → 判定 → `POST` 中台 `/v1/tell`（body 只有 `{key,text}`，
`Authorization: Bearer <source.key>`）→ 中台经飞书 + 桌面通知推卡片」，**不经过模型、不产生 token**：

1. **异常即时提醒**：`status==='error'`（读不到）立即推；之前报过异常的 agent 恢复 `working`/`idle` 时推「恢复」。
   同一 agent 同类提醒默认 `cooldownSec=3600` 内最多 1 条。
2. **周期汇报**：默认每 **30 分钟**（`reportIntervalSec=1800`）推一条「Agent 运行汇报」；
   免打扰 23:00–08:00 不发周期汇报（异常即时提醒不受影响）。

> lite 没有 GUI Agent，因此没有「窗口消失/掉线」这一类提醒；`offline` 只是「很久没活动」，
> 不单独触发即时提醒。这样不会因为某天没用 Claude 就刷一条假异常。

两种消息都带**全量概览**：3 个 Agent 各一行现状（状态 + 最近活动 + 当前步骤）+「遇到问题」小节，
中文纯文本、无 markdown 表格、≤2000 字。

### 消息格式

```text
【Agent 运行汇报】11-06 15:30
Claude：空闲 21 分钟 · 会话「手表 copy」 · 最近：整理美国/迪拜发布节点
Codex：空闲 52 分钟 · 会话「gif 表情包开发」 · 最近：检查 4 张旧版 GIF
DSH：在干活 · 会话「Agent-autoloop 逻辑与 DPH 插件方案」 · 最近：调用工具 bash
✅ 全部 3 个正常。
（每 30 分钟自动汇报；异常变化即时提醒）
```

- 异常即时提醒把第一行换成 `⚠️ Agent 异常：<name> 读不到（<原因>）`，第二行是 `【Agent 现状】<时间>`，
  后面是同样的 3 行现状 + 问题小节；恢复时第一行是 `✅ Agent 恢复：<name> 已恢复（原因）`。
- 「遇到问题」判定（每条推送的问题小节都汇总所有命中项）：
  - `status === 'error'` → `<name> 读不到（detail 截断 80 字）`
  - 最近步骤文本命中 `/报错|失败|异常|错误|error|failed|exception|超时|timeout/i` →
    `<name> 疑似报错（命中句截断 60 字）`（只进问题小节，不单独触发即时提醒）
  - 其余算正常；全部正常时显示 `✅ 全部 3 个正常。`
- 状态文案：`在干活` / `空闲 N 分钟`（N 分钟/小时/天）/ `离线（很久没活动）` / `异常（读不到）`。

### 异常即时提醒规则

| 触发 | 条件 | 首行文案 |
| --- | --- | --- |
| 读不到 | 任意 agent `status === 'error'` | `⚠️ Agent 异常：<name> 读不到（<detail 截断 120 字>）` |
| 恢复 | 之前报过异常（`alerted`）的 agent 回到 `working` / `idle` | `✅ Agent 恢复：<name> 已恢复（正在干活/空闲）` |

- 首次 tick 只写基线、不推异常（插件刚装/刚重启不会轰炸）；但 `status:'error'` 例外，马上推。
- 去重 key `obs-<agent>-<kind>-<hourBucket>`（`hourBucket = Math.floor(Date.now()/3600000)`），
  同 key 由中台幂等去重，本地冷却 + 中台幂等双保险。
- 「恢复」默认开，`recovery:false` 可关。
- 状态落 `~/.cache/dsh-agent-observer/notify-state.json`：每个 agent 上次 `status`、每类提醒上次推送时间、
  最近 30 条推送记录；重启插件不会重复轰炸。
- 推送失败（中台没起 / 超时 / 401）不阻塞：失败也记进状态文件的 `lastPushes[].error`，下一 tick 重试；
  `/agents/summary`、`/agents/:id/steps`、`agents_status` 完全不受影响。

### 周期汇报

- 默认 `reportEnabled:true`、`reportIntervalSec:1800`（30 分钟）。**首次 tick 只写基线 `reportBaselineAt`，不自动发**；
  之后按「上次汇报/基线 + interval」到期才发。想立即看一条就调 `POST /agents/notify/report`。
- 免打扰 `quietHours` 默认 23:00–08:00（本地时间）：到期若落在该时段就跳过，等时段结束后的第一个 tick 补发；
  异常即时提醒不受免打扰影响。
- 汇报 key 是 `obs-report-<YYYYMMDD-HH>`（本地时间小时桶），中台幂等；**发送成功才写 `lastReportAt`**，
  失败下个 tick 重试、不会重复刷屏。
- 手动 `POST /agents/notify/report` 立即发一条（忽略免打扰），返回 `{sent,duplicate,dryRun,key,at,text}`；
  `DRY_RUN=1` 时不真发。它和自动汇报共用同一个 key，同一小时内重复触发会返回 `duplicate:true`。

### 配置

默认值写死在 `lib/notify.js` 的 `DEFAULT_CONFIG`，可用 `~/.cache/dsh-agent-observer/notify.json` 覆盖：

```json
{
  "enabled": true,
  "intervalSec": 120,
  "cooldownSec": 3600,
  "recovery": true,
  "tellSource": "",
  "reportEnabled": true,
  "reportIntervalSec": 1800,
  "quietHours": { "start": 23, "end": 8 }
}
```

- `enabled:false` → 后台 tick 直接跳过（不再采集、也不发周期汇报），彻底零网络。
- `intervalSec` 钳制到 15–86400s，`cooldownSec` 钳制到 60–604800s，`reportIntervalSec` 钳制到 60–604800s；
  **改 `intervalSec` 需 reload 插件**（定时器在 apply 时按当时的配置创建，其余字段每个 tick 重新读）。
- `quietHours` 支持 `{"start":23,"end":8}` 或 `"23:00-08:00"`；写 `false`/`null` 关闭免打扰。
- `tellSource` 可选：覆盖 `~/.agent-autoloop/config.json` 的 `source.key`；不是合法 tell key 时忽略。
- 中台地址与来源密钥来自现有 `~/.agent-autoloop/config.json` 的 `url` + `source.key`（插件不复制、不下发密钥）。
  没装中台/没来源密钥时提醒自动关闭，`GET /agents/notify/state` 返回 `hub:{configured:false,error:{code}}`。

### 调试与验证

- `GET /agents/notify/state`：看 `enabled/intervalSec/cooldownSec`、`hub.configured`、
  上次 tick 的 `lastState.agents`、`lastPushes`，以及
  `report:{enabled,intervalSec,lastReportAt,lastReportKey,quietHours,quietNow,nextDueAt}`。
- `POST /agents/notify/test`：发一条固定测试卡片（key `obs-test-<毫秒>`，文案带当前时间）。
- `POST /agents/notify/report`：立即发一条完整周期汇报（**推荐装完用它做真实验证**）。
- 不真发联调：`DRY_RUN=1 node lib/agents/selftest.mjs`（或 `DRY_RUN=1` 启动插件）。
- 自测用环境变量 `AGENT_OBSERVER_NOTIFY_CONFIG` / `AGENT_OBSERVER_NOTIFY_STATE` 把配置/状态文件指到 `/tmp`
  （selftest 已这么做，不会碰真实 `~/.cache` 状态）。

### 怎么关

1. 只关周期汇报：`notify.json` 写 `{"reportEnabled": false}`，异常即时提醒继续。
2. 全关：`notify.json` 写 `{"enabled": false}`，下一个 tick 起不再采集/推送（手动 test/report 仍可用）。
3. 彻底关：在 DSH profile 里停用本插件。

## 性能（本机实测）

- `GET /agents/summary`：冷启动约 85–110ms（3 个 agent 全部读文件）。
- `GET /agents/:id/steps`：Claude 1–2ms、Codex 6–7ms、DSH 75–95ms（多段 zstd 解压）。
- 提醒 tick：每 120s 一次 `collectSummary()`，无异常且未到汇报时间时零网络；
  只在异常即时提醒或周期汇报真正发送时才调 `/v1/tell`（10s 超时）。
- 所有子进程调用已随 GUI 采集移除；本插件无 `child_process` 依赖。

## 自测

```bash
DRY_RUN=1 node lib/agents/selftest.mjs
```

2026-11-08 本机实测 **39/39 通过**（全程 dry-run，没有真发飞书，状态文件用 /tmp）：

```
summary 108ms | claude idle/742s/「INS 补图…」 | codex idle/495s/「bigdanny 工作区」
               | dsh working/0s/「客户系统架构搭建方案」；3 agents，无 GUI 字段
steps  claude 1ms/3 条 · codex 6ms/3 条 · dsh 94ms/3 条
unknown-agent → code UNKNOWN_AGENT；grokbot 已移除 → UNKNOWN_AGENT
notify hub=已配置（不打印密钥） 默认 enabled/120s/3600s/report 1800s/quiet 23-8
       tick（假 summary + /tmp 状态文件）：baseline 3 → idle→offline 不推
       → error 1 条 → 冷却 → recovery 1 条；状态文件读写/重启不重复
       enabled=false 直接跳过；坏 key → code BAD_KEY；DRY_RUN 不打网络
route  /agents/notify/state 200（report.intervalSec=1800）| POST /agents/notify/test dryRun
       POST /agents/notify/report dryRun | GET /agents/notify/report 405 METHOD
       /agents/summary 3 agents | /agents/dsh/steps 200 | /agents/notify 404 NOT_FOUND
       POST /agents/claude/snapshot 404、GET /agents/claude/snapshot.png 404（截图路由已删除）
report 文本 211 字（fixture）含 3 行现状 + 问题小节；error/疑似报错/全正常都覆盖
       首次 tick 只写基线（不发）→ 30min 后发（key obs-report-YYYYMMDD-HH）→ 30min 内不重发
       23:30 免打扰跳过 → 次日 08:05 补发；手动 POST report 立即发（忽略免打扰）
```

脚本最后还会打印一份「截断后的 JSON」（每个 agent 的 status/step、steps、提醒测试摘要，文本 ≤100 字），可直接贴给上游。

## 已知限制

- **只有 Claude / Codex / DSH**：Grok Bot / Muse 等 GUI Agent 不在 lite 范围；要看窗口画面请用完整版插件或桌面自动化工具。
- **Claude / Codex 靠文件**：只读得到落盘内容；正在生成中的最后几个 token 可能还没写进文件。
  Claude 后台 SDK 会话（`entrypoint` 以 `sdk-` 开头）被有意排除。
- **DSH 会话**：多段 zstd 用 magic 扫描切帧，理论上压缩数据内出现同样 4 字节会误切，
  此时该帧解压失败被跳过（不会抛错，最多丢一帧内容）。
- **需要 Node 22.15+**：DSH 会话读取用到 `node:zlib` 的内置 zstd（DSH 自带运行时满足要求）。
- **飞书提醒依赖本机中台**：agent-autoloop 没起/密钥失效时提醒发不出去（会记在 `lastPushes[].error`），
  但不影响读取；后台 120s 一次采集，最迟约 2 分钟发现异常，改 `intervalSec` 要 reload。
- **汇报内容是「上次落盘」的摘要**：不是实时画面；某行信息缺失时显示 `最近：—`，不会编造。
- **免打扰按本机本地时间**判断，跨时区/改系统时区后以本机时钟为准；免打扰只拦周期汇报。
- 仅依赖本机文件与 HTTP 出站到 `127.0.0.1:3350`；macOS / Linux 均可用（无平台专属二进制）。

## 隐私与安全

- 只监听 DSH 已绑定的本机 HTTP server（与现有插件同款做法），同源路由不带额外 token；
  安全性依赖「只 bind 127.0.0.1」，不要把 DSH Web GUI 暴露到局域网/公网。
- 不往外部网络发数据；唯一的出站请求是「飞书提醒」发往本机中台 `127.0.0.1:3350` 的 `/v1/tell`
  （可在 `notify.json` 里关闭）。
- 飞书提醒只读 `~/.agent-autoloop/config.json` 的 `url` + `source.key`：密钥只在 Host 内拼
  `Authorization` 头，不写日志、不出现在路由/工具返回值里。
- 推送文案与 `/agents/summary` 同级：agent 名、状态、会话标题（截断 30 字）、最近步骤（截断 70 字）、
  采集错误 detail（截断 80/120 字），不含会话正文全文；`notify-state.json` 只存状态/时间/截断后的文案。
- 工具 `agents_status` 只读，不提供任何回答/审批/控制能力；除会话目录与 `~/.agent-autoloop/config.json`
  外不读其它配置，也不写任何项目文件（提醒状态写 `~/.cache/dsh-agent-observer/`）。
- 终端输出/README 只放截断后的示例（≤100 字），不贴完整私有会话。
