# DSH 插件包（铁卡老弟中控台）

这个目录是「铁卡老弟」中控台在 **DeepSeek Harness（DSH）** 里的两个插件，可被**另一台 DSH**
用 `plugin_manager` 直接安装。两个插件都只依赖 DSH 自带能力和本机文件，没有第三方 npm 依赖、没有构建步骤。

| 目录 | 插件 | 显示名 | 角色 |
| --- | --- | --- | --- |
| [`dsh-autoloop-panel/`](dsh-autoloop-panel/) | `@local/dsh-autoloop-panel`（条目 `autoloop-panel`） | **铁卡老弟**（Tieka Bro） | 侧栏面板：总览 / 审批卡片 / 在跑排队 / 花费 + **Agents tab** |
| [`dsh-agent-observer/`](dsh-agent-observer/) | `@local/dsh-agent-observer`（条目 `agent-observer`） | Agent 观察台 lite | 只读采集 Claude / Codex / DSH 进度；`/agents/*` 路由；飞书异常提醒 + 30 分钟汇报 |

## 两个插件什么关系

```
~/.agent-autoloop/config.json ──url+owner──▶ 铁卡老弟面板 Host 半 ──▶ agent-autoloop 中台 :3350
                                                │  同源代理 /autoloop/*
                                                ▼
                                  铁卡老弟面板 Client 半（总览 + 审批 + Agents tab）
                                                │  fetch /agents/*
                                                ▼
                  Agent 观察台 lite（Host 半）──▶ 只读 ~/.claude ~/.codex ~/.dsh 的会话文件
                                                │
                                                └─ POST /v1/tell ──▶ 中台 ──▶ 飞书（异常提醒 / 30 分钟汇报）
```

- **面板不自己读 Agent 进度**：Agents tab 的数据全部来自观察台的 `/agents/summary`、`/agents/:id/steps` 路由。
  只装面板 → 总览/审批能用，Agents tab 显示「没装 dsh-agent-observer」。
- **观察台不依赖面板**：只装观察台 → `/agents/*` 路由、`agents_status` 工具、飞书提醒都工作，只是 DSH 里没有面板入口。
- **两个都依赖 autoloop 中台在跑**：面板要它提供 `/v1/state`；观察台的飞书提醒要它提供 `/v1/tell`。
  没起中台时：面板显示安装/启动步骤；观察台照常读会话文件，只是提醒自动降级（`/agents/notify/state` 显示 `hub.configured=false`）。
- 观察台**只监控 Claude / Codex / DSH 三个 CLI Agent**，是 lite 版：没有 Grok Bot / Muse、没有截图、没有 OCR、
  没有 `/agents/:id/snapshot*` 路由，**不需要屏幕录制/辅助功能权限**。

## 前置条件

- 目标机器已装好 **DSH 桌面版**并登录、能打开 Web GUI。
- 目标机器已按仓库根目录的 [INSTALL.md](../INSTALL.md) 装好并启动 **agent-autoloop 中台**
  （`~/.agent-autoloop/config.json` 里有 `url` 和本人 `owner` 密钥）。
- 本机有 `~/.claude`、`~/.codex`、`~/.dsh` 中的会话文件（没有也能装，对应 agent 显示「没有找到会话文件」）。
- 在 DSH 里执行安装的 Agent 需要有 **Full access**，或至少能通过 `plugin_manager install_bundle` 的审批。

## 安装

**顺序：先 autoloop 中台，再装插件。**

1. 启动 autoloop 中台（若还没装）：

   ```bash
   curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
   agent-autoloop up
   ```

2. 在**目标机器**的 DSH 会话里（不是终端）让 Agent 执行两次安装，`target` 用仓库在本机的真实绝对路径：

   ```text
   plugin_manager({ action: "install_bundle", target: "<repo绝对路径>/plugins/dsh-autoloop-panel" })
   plugin_manager({ action: "install_bundle", target: "<repo绝对路径>/plugins/dsh-agent-observer" })
   ```

   - 需要 **Full access / 审批**；审批关闭的会话会直接返回失败，请让人类在 DSH 里授予。
   - 返回 `application: applied` 即生效；`warnings` 应为空。
   - 安装会改动 DSH profile 的插件清单——**不要手写 profile 的 `package.json`/`cordis.patch.yml`**，
     一律走 `plugin_manager`。

3. 装完 **刷新 DSH 页面**（Cmd+R）；首次安装若侧栏图标没出现，重启一次 DSH。

4. 验证（`<PORT>` 从 `lsof -nP -iTCP -sTCP:LISTEN | grep -i deepseek` 找）：

   ```bash
   curl -s http://127.0.0.1:<PORT>/autoloop/meta       # {"ok":true,...,"installed":true,"hasOwner":true}
   curl -s http://127.0.0.1:<PORT>/autoloop/state      # totals / agents / channels
   curl -s http://127.0.0.1:<PORT>/agents/summary      # 3 个 agent：claude / codex / dsh
   curl -s http://127.0.0.1:<PORT>/agents/notify/state # report.intervalSec=1800, quietHours 23-8
   ```

   侧栏出现「铁卡老弟」→ 总览有轮次/花费；点开 Agents 页能看到 **Claude / Codex / DSH** 三行。

5. （可选）验证飞书通道：`POST /agents/notify/test` 收测试卡；`POST /agents/notify/report` 收一条 3 行运行汇报。

## 文件清单

```
plugins/
├─ README.md                        # 本文件（关系图 + 安装 + 验收）
├─ dsh-autoloop-panel/
│  ├─ package.json                  # name/version/meta/dsh.bundle.patch/dsh.client(web)
│  ├─ cordis.patch.yml              # insert: {id: autoloop-panel, name: '@local/dsh-autoloop-panel'}
│  ├─ icon.svg                      # 侧栏/插件列表图标
│  ├─ locale/zh.json + en.json      # 显示名「铁卡老弟」/「Tieka Bro」
│  ├─ lib/index.js                  # Host 半：/autoloop/* 同源代理 + autoloop_status 工具
│  ├─ client/client.js              # Client 半：侧栏图标 + 主面板 + Agents tab
│  └─ README.md                     # 功能 / 安装 / 路由 / 边界
└─ dsh-agent-observer/
   ├─ package.json                  # name/version/meta/dsh.bundle.patch
   ├─ cordis.patch.yml              # insert: {id: agent-observer, name: '@local/dsh-agent-observer'}
   ├─ icon.svg
   ├─ locale/zh.json + en.json      # 「Agent 观察台 lite」/「Agent Observer lite」
   ├─ lib/index.js                  # Host 入口：/agents/* 路由 + agents_status 工具 + 提醒循环
   ├─ lib/notify.js                 # 飞书异常提醒 + 30 分钟汇报 + 冷却/免打扰/状态
   ├─ lib/util.js                   # 尾部读取 / 多段 zstd 解压 / 截断
   ├─ lib/agents/{index,claude,codex,dsh}.js
   ├─ lib/agents/selftest.mjs       # DRY_RUN=1 自测
   └─ README.md                     # 功能 / 安装 / 路由 / 提示配置 / 自测 / 限制
```

## 配置与数据落在哪

| 内容 | 位置 | 谁写 |
| --- | --- | --- |
| 中台地址 + owner/source 密钥 | `~/.agent-autoloop/config.json`（既有文件，插件只读） | autoloop 安装器/中台 |
| 提醒配置（间隔、免打扰、汇报频率） | `~/.cache/dsh-agent-observer/notify.json`（可选，不存在用默认值） | 人 |
| 提醒状态（上次推送/冷却/最近 30 条） | `~/.cache/dsh-agent-observer/notify-state.json` | 观察台 |
| 会话数据 | `~/.claude`、`~/.codex`、`~/.dsh`（插件只读） | 各 CLI |

**仓库里没有任何密钥、飞书 App ID、open_id 或本机绝对路径**；App Secret 只进 macOS Keychain / 本机配置文件，
目标机器上现场生成。插件只读 `~/.agent-autoloop/config.json` 的 `url` 与密钥，密钥只在 Host 进程内使用。

## 已知限制与风险

1. **DSH 本地路由没有额外鉴权**：`/autoloop/*`、`/agents/*`（含审批动作）都是 localhost 裸路由，
   安全边界只靠 DSH 绑定 `127.0.0.1`。不要把 DSH Web GUI 暴露到局域网/公网。
2. **中台依赖**：autoloop 是外部 Node 服务；中台停/改版会同时影响面板总览与飞书提醒。插件本身不代装、不代管。
3. **DSH 版本兼容**：面向 DSH 0.2.x（0.2.2-rc.1 实测）。插件 API（`webServer.register`、`tools.register`、
   `slots.register`、`dsh.client.web`）随版本可能微调；升级 DSH 后若面板不出现，先对照新版插件文档检查槽位名。
4. **Agent 数据有落盘延迟**：Claude / Codex 是追加写，正在生成的内容可能还没落盘；面板显示的是「最近落盘的一步」。
5. **观察台已是 lite**：不含 Grok Bot / Muse 的窗口截图与 OCR；需要那类能力请另配完整版或桌面自动化栈。
6. **飞书提醒需要真实凭据**：中台 `source.key` 缺失/失效时提醒发不出去（只记在状态文件里），不影响读取；
   装完建议先 `POST /agents/notify/test` 验证。
7. **首次汇报不自动发**：观察台首次 tick 只写基线，30 分钟后才发第一条自动汇报；想立刻看到就手动
   `POST /agents/notify/report`。
8. **安装只走 `plugin_manager`**：目标 DSH 的 `install_bundle` 对「本地目录」的支持随版本可能不同；
   如果它返回无法解析 target 或要求 `nextStep`，按返回提示处理后重试（必要时把插件目录 `npm pack` 成
   tarball 再装），**不要手写 profile 的 `package.json`/`cordis.patch.yml`**。
