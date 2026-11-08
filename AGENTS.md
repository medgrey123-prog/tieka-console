# AGENTS.md — 给目标机器上 DSH Agent 的施工单

你现在要在这台 Mac 上，把「铁卡老弟」中控台装起来。
**先读完本文件，再开始动手。** 详细步骤在 [INSTALL.md](INSTALL.md)，配置手册在 [docs/FEISHU-SETUP.md](docs/FEISHU-SETUP.md)、[docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)。

## 0. 你的角色与原则

1. **一步一步做，每步先检查现状。** 所有脚本都设计了幂等；不要因为"看起来装过了"就跳过检查。
2. **只改该改的东西。** 不要重装/重启 DSH 本身；不要手写 DSH profile 的 `package.json`/`cordis.patch.yml`（插件安装必须走 `plugin_manager` 工具）；不要改用户已有项目的文件。
3. **密钥不外泄。** App Secret、autoloop key、open_id、master.key 不进日志、不进聊天记录、不写进仓库。需要用户提供时，让用户自己粘贴到终端 stdin 或私密渠道。
4. **对外发送/花钱/删除的动作先问用户。** 包括：让任务机器人真的发消息、让 autoloop 触发真实业务、卸载已有服务。
5. **失败要回滚 + 报告。** 每个脚本都会备份；失败时恢复备份、如实说明卡在哪，不要"重试到看起来成功"。

## 1. 三个必须停下来问用户的闸口

| 闸口 | 什么时候 | 问什么 |
|---|---|---|
| G1 | INSTALL 第 1 步 | 两个飞书应用的 **App ID / App Secret** 是否已建好发布？Secret 让用户自己粘到 stdin。 |
| G2 | INSTALL 第 5 步 | `plugin_manager install_bundle` 需要 Full access/审批；被拒时请用户授予。 |
| G3 | INSTALL 第 6 步 | 任务发布机器人首次回传的 **open_id** 需要用户确认（或从日志读出后请用户确认）。 |

其他步骤自己完成，不要频繁打扰。

## 2. 执行顺序（对应 INSTALL.md）

```text
0  bash bin/env-check.sh              # 缺硬性项就停下，让用户装
1  用户建两个国内飞书应用             # G1
2  bash bin/install-autoloop.sh       # 安装/检查 autoloop
3  bash feishu/setup-review-bot.sh --profile tieka-review --app-id <ID> --login
   → 记下脚本输出的 OPEN_ID
   bash feishu/setup-review-bot.sh --profile tieka-review --app-id <ID> --owner <OPEN_ID> < secret
4  bash bin/apply-autoloop-config.sh --owner-open-id <OPEN_ID>
   agent-autoloop check；重启中台
5  plugin_manager install_bundle ×2    # G2；装完刷新页面/重启 DSH
5.5 cp -R skills/feishu-task-ops skills/agent-autoloop ~/.dsh/skills/   # 让任务机器人按你的用法干活
6  bash feishu/setup-task-bot.sh --profile tieka-task --app-id <ID> < secret
   → 让用户去飞书给任务机器人发「你好」→ 拿 open_id → 重跑加 --owner   # G3
7  POST /agents/notify/test 与 /agents/notify/report 验证汇报
   ./verify-install.sh
8  收尾：改名、权限复查、写变更说明
```

## 3. 每步的验证要求

- 第 2 步后：`agent-autoloop status` 显示 worker/通道在线；`agent-autoloop doctor` 只允许「系统服务没在跑」一项可接受（如果用户选了 `--no-service`）。
- 第 3 步后：`agent-autoloop status` 看到「审阅机器人」通道在线。
- 第 4 步后：`agent-autoloop check` 输出「规则没问题」；`status` 列出 4 条规则、3 个 Agent（DSH/Codex/Claude）。
- 第 5 步后：DSH 侧栏有「铁卡老弟」；Agents 页有 Claude/Codex/DSH；`cordis_inspect_query` 能看到两个插件行（或咨询用户的页面观察）。
- 第 6 步后：`lark-cli event status` 里任务机器人有 `im.message.receive_v1` consumer；`~/.dsh-lark-bot/logs/` 有「事件监听已就绪」。
- 第 7 步后：审阅机器人收到「测试卡 + Agent 运行汇报」；`./verify-install.sh` 全绿。

## 4. 报告格式（装完给用户）

```
一、装了什么（版本/路径）
二、验收结果（对照 README 第 5 节 7 项，逐条 ✅/❌）
三、日常怎么用（飞书两个机器人各自的用途；面板两个 tab）
四、怎么改（汇报频率、规则、白名单、机器人改名）
五、已知限制与风险
六、回滚方式
```

## 5. 遇到问题

- 排障优先级：`docs/TROUBLESHOOTING.md` → 脚本 `--help` → 飞书开放平台事件/权限状态 → 用户。
- 不要为了"让它看起来通了"去伪造状态：发送失败就是失败，卡片没收到就说没收到。
- 不要动用户的 `~/.dsh` 插件清单、不要删除已有插件。
