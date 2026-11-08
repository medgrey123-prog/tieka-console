# 规则模板说明（rules.example.json）

`rules.example.json` 是给 **agent-autoloop** 的规则模板：一份文件说清「什么事件、交给谁、在哪干、照什么做」。
JSON 不能写注释，所以字段解释、怎么改、怎么加「巡检 / 排障」都放这里。

- 上游项目：<https://github.com/KKKKhazix/agent-autoloop>（MIT，Node ≥ 24，零依赖）
- 上游规则手册：仓库里的 `skills/agent-autoloop/SKILL.md`（本套件在 `skills/agent-autoloop/` 有一份快照）
- **不要直接拿模板当配置用**：里面还有 `{{…}}` 占位符，用 `bin/apply-autoloop-config.sh` 生成真正的
  `~/.agent-autoloop/rules.json`。

## 1. 怎么生成

```bash
bash bin/apply-autoloop-config.sh \
  --owner-open-id ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --worker "$(hostname -s)" \
  --cwd-try "$HOME/tieka-try"
```

- `--owner-open-id`：飞书里能回答卡片的人（本人）的 open_id，填进 `channels.feishu.answerers`。
- `--worker`：接单电脑名，必须和 `~/.agent-autoloop/config.json` 里 `worker.name` 一致；
  不传时脚本先读 `config.json`，读不到再用 `hostname`。
- `--cwd-try` / `--cwd-code` / `--cwd-work`：三条占位目录，默认 `~/tieka-try`、`~/tieka-code`、`~/tieka-work`。
  目录要先建好（`mkdir -p`），规则里的 `cwd` 不存在时任务会在启动时报「目录不存在」。
- `--no-feishu`：先不接飞书，生成时去掉 `channels.feishu`；之后接好再重新生成。
- `--dry-run`：只把将写入的 JSON 打到 stdout，不碰磁盘。脚本会自动备份旧 `rules.json`、写完后
  `agent-autoloop check`，检查失败自动回滚。

## 2. 占位符

| 占位符 | 来自哪里 | 示例 |
| --- | --- | --- |
| `{{WORKER}}` | `--worker` / `config.json` / `hostname` | `mac-mini` |
| `{{OWNER_OPEN_ID}}` | `--owner-open-id` | `ou_xxxxxxxx` |
| `{{CWD_TRY}}` | `--cwd-try` | `~/tieka-try` |
| `{{CWD_CODE}}` | `--cwd-code` | `~/tieka-code` |
| `{{CWD_WORK}}` | `--cwd-work` | `~/tieka-work` |

生成后文件里不应再有 `{{`；有就是漏了参数，`check` 不会通过。

## 3. 顶层字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `timezone` | 否 | cron 按哪个时区算，默认本机时区；跨机部署时写死 `Asia/Shanghai` 更稳。 |
| `askFirst` | 否 | 「什么事必须先问人」的清单，默认 7 类：删数据、停服、花钱、对外发消息、改产品方向、新建或轮换密钥、修改权限。 |
| `sources` | 是 | 事件来源登记表。`local` 是本机来源（`agent-autoloop emit` / `try` 用它）；外部系统要登记自己的来源并建来源密钥。 |
| `agents` | 是 | 干活的 Agent 登记表：`use` 决定用哪种 CLI（`command` / `claude` / `codex` / `acp` / 插件）。 |
| `channels` | 否 | 卡片发到哪：`desktop` 桌面通知、`feishu` 飞书；`answerers` 是允许回答的人。 |
| `rules` | 是 | 规则列表，每轮由「事件」或「cron」触发。 |
| `elsewhere` | 否 | 在别处（Claude/Codex 应用里）定时的任务，只用于 `agent-autoloop status` 展示，中台不启动它们。 |

## 4. Agent 三种配法

模板里登记了三个 Agent，`worker` 都填同一台接单电脑：

```json
"dsh":    { "name": "DSH", "worker": "{{WORKER}}", "use": "command",
            "command": ["dsh", "--profile", "headless", "{prompt}"] },
"claude": { "name": "Claude Code", "worker": "{{WORKER}}", "use": "claude", "access": "edit" },
"codex":  { "name": "Codex", "worker": "{{WORKER}}", "use": "codex", "access": "read" }
```

- `use`：`claude` / `codex` 用内置适配器（自动拼命令行、支持会话接续和用量上报）；`command` 是「任何能打印最后一条消息的命令」，
  脚本、别的 CLI 都行。`command` 里的 `{prompt}` 会换成这轮提示词，`{cwd}` 换成规则目录，`{context}` 换成资料文件路径。
- `access`：`read`（只读）/ `edit`（可改文件，默认）/ `full`（不改也不审批，慎用）。排障类建议 `read`。
- 本套件用 **DSH 跑批量、Codex 只读排障、Claude 做需要编辑的复盘/整理**：
  DSH 走 `dsh --profile headless`，不弹窗、按提示词跑完退出，适合定时任务。
- `worker` 写错（和 `config.json` 的 `worker.name` 不一致）时，这个 Agent 永远不会被派活；
  `agent-autoloop status` 里能看到在线的是哪台。

## 5. 规则字段

```json
{
  "name": "规则名（唯一）",
  "when": { "source": "local", "types": ["task.*"] },
  "to": "agent 的编号",
  "cwd": "~/已有的目录",
  "skill": "可选：技能名",
  "prompt": "可选：照什么做",
  "parallel": 2,
  "emits": { "source": "myservice", "types": ["svc.down"] },
  "tell": "needed",
  "group": "可选：分组"
}
```

- `when`：二选一。事件式写 `source` + `types`（支持 `alert.*` 这类通配）；定时式写 `cron`（5 段，按 `timezone`/本机时区）。
- `to`：`agents` 里的编号；一个规则只能交给一个 Agent。
- `cwd`：Agent 干活的工作目录，`~/...` 或绝对路径，**必须存在**；它也是 `{cwd}` 的取值。
- `skill` / `prompt`：至少写一个（`command` Agent 的规则可以不写，因为脚本自己知道做什么）。
- `parallel`：同一个 `group` 里按 subject 分道、最多几条同时跑；不写就是一条一条来。
- `emits`：允许这条规则的回执发哪些事件（事件来源 + 类型），回执里发别的事件会被拒绝。
  它也是「巡检脚本 → 排障 Agent」的桥。
- `tell`：`always` 每轮都汇报、`needed`（默认）只在有卡片时提醒、`never` 不提醒。
- `group`：限并发用的分组，默认等于规则名。

改完运行 `agent-autoloop check`，几秒内自动生效；写错了旧规则继续跑，并推一张卡片告诉你错在哪。

## 6. 模板里四条规则分别演示什么

1. **试一下**（`local` / `try.*` → DSH，cwd `{{CWD_TRY}}`）
   `agent-autoloop try` 发的就是 `try.start` 事件。规则名保持「试一下」别改：CLI 靠这个名字判断重试。
   提示词要求问一个标题以「试跑」开头的问题（CLI 靠这个识别卡片），回答后续做完成。
   验收：改完规则先跑一次 `agent-autoloop try`，确认「问问题 → 回答 → 完成」整条链路通。
   **`try` 会真实调用 DSH，消耗模型额度。**
2. **每日简报**（cron `0 8 * * *` → DSH，cwd `{{CWD_WORK}}`）
   每天 8 点（按 `timezone`）让 DSH 读资料文件、整理昨天与待办，第一行结论、后面最多五条。
   改成自己的目录、自己的汇报口径；`tell: always` 让每轮结果都以通知卡片发出来。
3. **每周复盘**（cron `0 19 * * 0` → Claude，cwd `{{CWD_WORK}}`）
   周日 19 点，Claude 做需要一点编辑/归纳的周复盘：做成了什么、卡在哪、下周建议；要拍板的用 `ask`。
4. **代码任务**（`local` / `task.*` → Codex，cwd `{{CWD_CODE}}`，`parallel: 2`）
   演示「事件 → Codex 干活」：别的系统或你自己发一条 `task.*` 事件，Codex 在项目里按 `detail` 做最小改动，
   同一 subject 最多两条并行。想换成 Claude 干活就把 `to` 改成 `claude`，并把 `access` 改成 `edit`。

## 7. 怎么加「巡检」和「排障」类规则

这是上游 `examples/recipes/website-watch`（网站巡检）和 `examples/recipes/ops-alerts`（线上报错）的同款结构：
**command Agent 跑固定脚本（正常零 Token）→ 异常时回执发事件 → 另一个 Agent 只读排障 → 需要人决定时问。**

### 7.1 巡检：脚本先查，异常才交活

```json
"sources": { "local": { "name": "本机" }, "myservice": { "name": "我的服务" } },
"agents": {
  "checker": {
    "name": "服务巡检脚本",
    "worker": "{{WORKER}}",
    "use": "command",
    "command": ["node", "{cwd}/check.mjs", "{context}"]
  },
  "fixer": {
    "name": "排障 Codex",
    "worker": "{{WORKER}}",
    "use": "codex",
    "access": "read"
  }
},
"rules": [
  {
    "name": "服务巡检",
    "when": { "cron": "*/5 * * * *" },
    "to": "checker",
    "cwd": "~/tieka-checks/myservice",
    "tell": "needed",
    "emits": { "source": "myservice", "types": ["svc.down", "svc.recovered"] }
  },
  {
    "name": "服务排障",
    "when": { "source": "myservice", "types": ["svc.down", "svc.recovered"] },
    "to": "fixer",
    "cwd": "~/tieka-code",
    "skill": "ops-alerts",
    "tell": "needed"
  }
]
```

脚本约定（和本套件的其它脚本一致，也是 autoloop command agent 的通用约定）：

- 脚本标准输出的**最后一条消息**就是回执：第一行结论 + 末尾可选一个 ` ```agent-autoloop ` JSON 块。
- 第一行三选一：`没事可做：…`（看过了，没有要做的）、`没跑成：…`（可自动重试的临时失败才会重派）、
  其余一句话（做成了什么）。**业务异常不算脚本失败**：异常时正常退出并交 `events`/`ask`，不要写「没跑成」。
- 回执字段：`{"events":[{"id","type","subject","summary"}], "ask":[{"title","text","options","key"}], "notice":[...], "resolve":[...], "later":[...]}`。
- 事件 `id` 要稳定（例如 `down-<故障开始时间>`）：同一个故障重复上报会被内核去重，不会反复派活。
- 正常时**不附回执、不发事件**，这一轮不进模型，零 Token；异常才把活交给 `fixer`。
- 需要人拍板时用 `ask`（`key` 固定，卡片还开着时不会重复问）；人回答后 `answers` 会随下一轮资料文件回来，
  脚本/Agent 按回答继续（例如「重启」或「先别动」）。
- 资料文件路径通过参数 `{context}` 传入，环境变量 `AGENT_AUTOLOOP_CONTEXT` 也是同一路径；里面是 `events`/`answers`/`open`/`decided` 等只读资料。
- 参考：上游 [`examples/recipes/website-watch`](https://github.com/KKKKhazix/agent-autoloop/tree/main/examples/recipes/website-watch)
  的 `check.ts`、`rules.json` 和 README。

### 7.2 排障：只读、给结论、不自己重启

- 给排障 Agent `access: "read"`，prompt 里写清「只看不改：不改代码、不改配置、不启停服务」。
- 排障结果用 `notice` 发给老板（标题一句话、正文三行以内：什么原因、影响什么、建议怎么办），
  不写文件路径和技术缩写。
- 真正要重启/改配置时，走 `ask` 让人拍板，或者把「重启」做成另一个 command Agent 规则（参考 `ops-alerts`：
  报错 → 排障 Agent → `emits` 一个 `restart` 事件 → 重启脚本规则执行）。`askFirst` 里已经包含「停服」，
  这类动作必须先问。

## 8. 加自己的事件来源

- **对方能发 HTTP**：`agent-autoloop key new source myservice` 拿来源密钥（会显示一次，先问本人），
  在 `sources` 登记 `{"myservice":{"name":"我的服务"}}`，对方 `POST http://127.0.0.1:3350/v1/events`，
  Header `Authorization: Bearer <来源密钥>`，body `{"id","type","subject","summary","detail","link"}`。
  来源密钥可以发事件，不能读状态；中台默认只监听 127.0.0.1，跨机要按上游手册配置地址/隧道。
- **对方推不过来（中台在家用电脑）**：用「巡检」模式——cron + command Agent 定时拉取，有变化才 `emits`。
- **Webhook 签名格式不同**：在 `~/.agent-autoloop/plugins/<名字>/source.ts` 写来源插件，
  来源登记 `"adapter": "<名字>"`，入口是 `/v1/in/<名字>`，密钥放 `~/.agent-autoloop/secrets.env`。

## 9. 飞书通道要配两处

`rules.json` 只登记「谁能回答」，密钥和收件人在 `config.json`：

```jsonc
// rules.json
"channels": { "feishu": { "name": "飞书", "answerers": ["ou_本人的 open_id"] } }
// config.json（本套件的 apply 脚本不会改它）
"channels": { "feishu": { "key": "…", "user": "ou_本人的 open_id" } }
```

两处都有同名通道才生效。接入步骤：`npm i -g @larksuite/cli` → `lark-cli config init` → 在飞书开放平台给应用开机器人、
订阅卡片回传交互（长连接）→ `agent-autoloop key new channel feishu` 取密钥写入 `config.json` →
`agent-autoloop service install` 让中台重读 `config.json`。同一个飞书应用的卡片点击只能有一台电脑在听。

> 重复生成规则时，已有 `rules.json` 里 `channels.feishu.name` 的显示名会保留（例如飞书接入脚本改成的
> 「审阅机器人」），只按 `--owner-open-id` 更新 `answerers`；其它字段以模板和本次参数为准。

## 10. 校验、回滚与安全

- 改完规则：`agent-autoloop check`；看效果：`agent-autoloop status`；排查：`agent-autoloop doctor`。
- `bin/apply-autoloop-config.sh` 会先备份 `rules.json`（`rules.json.bak-时间戳`），check 失败自动恢复备份。
  `agent-autoloop check` 本身不会动正在跑的规则：写错了旧规则继续跑，并推卡片告诉你错在哪。
- **不要把真实 open_id、通道密钥、`config.json`、`master.key` 提交到仓库**；模板和文档里只用占位符。
- `agent-autoloop try` 会真实调用模型；定时任务也会消耗额度，先用 `tell` 和 cron 频率控制好节奏。
