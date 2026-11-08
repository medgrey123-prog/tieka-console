# dsh-autoloop-panel · 铁卡老弟

把本机 [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 中台搬进 DeepSeek Harness（DSH）：
侧栏一个图标，点开就能看全局、批卡片、停一轮、查花费。

> autoloop 官方仓库明确不提供界面（「想要一个页面或大屏，用本人那一节的几个请求自己做」）。
> 这个插件就是那个「本人客户端」：只读 + 人工审批，调度和事实日志仍然由 autoloop 内核负责。

包名 `@local/dsh-autoloop-panel`、Cordis 条目 id `autoloop-panel`、面板 key `autoloop` 都保持不变，
避免破坏已有的 profile 与热键/槽位兼容。

## 功能

- **侧栏图标 + 角标**：有待你拍板的卡片时显示数量；中台不可达时显示灰点。
- **待你拍板**：`ask` 卡片直接点选项回答（推荐项有标记），`notice` 点「已处理」；也可以写一句结果「结案」。
- **在跑 / 排队**：看轮次状态、重试次数、用时、Token 与费用，必要时「停止」这一轮。
- **最近完成**：结论、报错、用量、时间。
- **成员 / 规则**：Agent、通道在线状态；规则触发方式与下次运行时间；没有规则接的事件。
- **Agents tab**：Claude / Codex / DSH 的当前进度。数据由另一个插件 **`dsh-agent-observer`（Agent 观察台 lite）**
  提供，本插件只负责显示；没装观察台时该 tab 会提示去装。
- **给 Agent 的只读工具 `autoloop_status`**：DSH 里的 Agent 也能随时看「现在等我什么、在跑什么、今天花了多少」。
  （回答/结案刻意**不做成工具**——那是人的动作。）

## 安装

前置：目标机器已经装好并启动了 autoloop 中台（本插件不代装），
`~/.agent-autoloop/config.json` 里有 `url` 和本人 `owner` 密钥。

```bash
# 1) 装并启动 autoloop 中台（在目标机器终端里跑，本插件不代装）
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
agent-autoloop up
```

```text
# 2) 在 DSH 会话里装插件（需要 Full access 或审批）
plugin_manager({ action: "install_bundle", target: "<repo绝对路径>/plugins/dsh-autoloop-panel" })
```

- 返回 `application: applied` 即生效；`warnings` 必须为空。
- 装完 **刷新 DSH 页面**（Cmd+R）；首次安装若没出现图标，重启一次 DSH。
- 面板会自动读 `~/.agent-autoloop/config.json` 里的地址和 owner 密钥，不需要在插件里填任何密钥。

验证（把 `<PORT>` 换成 `lsof -nP -iTCP -sTCP:LISTEN | grep -i deepseek` 找到的端口）：

```bash
curl -s http://127.0.0.1:<PORT>/autoloop/meta   # installed:true, hasOwner:true
curl -s http://127.0.0.1:<PORT>/autoloop/state  # totals / agents / channels
```

## 依赖

| 依赖 | 必需 | 说明 |
| --- | --- | --- |
| agent-autoloop 中台 | 是 | 面板只做展示与代理；中台没起时面板会显示安装/启动步骤 |
| `~/.agent-autoloop/config.json` | 是 | 提供 `url` + `owner`（密钥只留在 Host 半） |
| dsh-agent-observer 插件 | 否 | 不装也能用总览/审批，只是 Agents tab 没有数据 |
| 第三方 npm 包 | 无 | 纯 JS，无构建步骤 |

## 结构

```
dsh-autoloop-panel/
├─ package.json          # dsh.bundle.patch + dsh.client(web)；meta 显示名「铁卡老弟」
├─ cordis.patch.yml      # insert 一行插件（id: autoloop-panel）
├─ icon.svg / locale/    # 显示元数据（中英；英文名 Tieka Bro）
├─ lib/index.js          # Host 半：读 config.json，同源代理 /autoloop/*，注册只读工具
└─ client/client.js      # Client 半：sidebar.panellist 图标 + main 全页面板（React）
```

Host 半提供的同源路由（浏览器直连中台 3350 会被 CORS 拦，所以必须经 Host 代理）：

| 路由 | 说明 |
| --- | --- |
| `GET /autoloop/meta` | 安装状态、config 路径、中台地址（**不含密钥**） |
| `GET /autoloop/state` | 代理 `GET /v1/state`（支持 `?before=` 翻页） |
| `POST /autoloop/action` | 代理 `answer` / `resolve` / `cancel`（只给面板的人操作） |
| `GET /autoloop/rules` | 只读 `~/.agent-autoloop/rules.json` |

## 边界与已知限制

- **owner 密钥只留在 Host 半**，不下发浏览器；面板只调同源 `/autoloop/*`。
- 路由是 localhost 上的裸路由（与 DSH 其他本地插件一致），**没有额外 token**：安全边界是本机
  `127.0.0.1`。不要把 DSH 的 Web GUI 端口暴露到局域网/公网。
- 只读中台暴露的接口；不直接读 `hub.db`、不改 `rules.json`（改规则仍走文件 + `agent-autoloop check`）。
- 中台没装/没起时，面板显示安装与启动步骤，不静默失败。
- 面向 DSH 0.2.x（0.2.2-rc.1 实测）；插件 API 随版本可能微调。若侧栏图标或主面板不出现，
  先看 DSH 是否支持 `sidebar.panellist` / `main` 槽位与 `dsh.client.web` 声明。
- 面板 5 秒轮询 `/autoloop/state`、侧栏图标 15 秒轮询；中台不可达时只显示灰点，不阻塞 DSH。
