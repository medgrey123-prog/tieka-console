# feishu/ — 两个飞书机器人的接入脚本

本目录只有两个安装脚本 + 共用函数库。**飞书应用本身的创建（能力/权限/事件/发布）不在脚本里**，
照仓库文档 [../docs/FEISHU-SETUP.md](../docs/FEISHU-SETUP.md) 在开放平台手工做一次，然后回来跑脚本。

| 脚本 | 机器人 | 做什么 | 写到哪 |
|---|---|---|---|
| `setup-review-bot.sh` | 审阅机器人（卡片/审批/汇报） | 建 lark-cli profile → 拿你的 open_id（`--owner` 或 `--login`）→ 写 wrapper → 生成/复用通道密钥 → patch autoloop 的 `config.json` + `rules.json` → `agent-autoloop check` | `~/.agent-autoloop/{lark-feishu.sh,config.json,rules.json}` |
| `setup-task-bot.sh` | 任务发布机器人（飞书发一句话，本机 DSH 执行） | 建 lark-cli profile → 写 wrapper → 生成 bot 配置 → 安装/启动 launchd | `~/.dsh-lark-bot/{lark-feishu-task.sh,config.json}`、`~/Library/LaunchAgents/com.tieka.dsh-lark-bot.plist` |

两个脚本都**幂等**，可反复运行；都支持 `--dry-run`；App Secret 只从 stdin（或终端无回显输入）读，
不会出现在命令行、进程列表、日志或仓库里。

---

## 1. 顺序（与 [INSTALL.md](../INSTALL.md) 一致）

```bash
# 0) 先确认环境（Node / lark-cli / autoloop / DSH）
bash bin/env-check.sh

# 1) 审阅机器人：先 --login 扫码拿 open_id（脚本会打印 OPEN_ID=ou_xxx）
bash feishu/setup-review-bot.sh --profile tieka-review --app-id <审阅机器人APP_ID> --login

# 2) 审阅机器人：用同一个 App Secret 真正接入 autoloop
bash feishu/setup-review-bot.sh \
  --profile tieka-review \
  --app-id <审阅机器人APP_ID> \
  --owner <OPEN_ID> \
  < <(printf '%s' '<审阅机器人APP_SECRET>')

# 3) 应用 autoloop 规则模板（会整体替换 rules.json，见下方说明）
bash bin/apply-autoloop-config.sh --owner-open-id <OPEN_ID>

# 4) 任务发布机器人：第一次装（还没有 --owner）
bash feishu/setup-task-bot.sh \
  --profile tieka-task \
  --app-id <任务发布机器人APP_ID> \
  < <(printf '%s' '<任务发布机器人APP_SECRET>')
#    → 去飞书给「任务发布机器人」发一句话，它会回你的 open_id
#    → 重跑（不用再传 Secret）：
bash feishu/setup-task-bot.sh --profile tieka-task --owner <OPEN_ID>
```

> **和 `bin/apply-autoloop-config.sh` 的关系**：那个脚本会用模板**整体替换** `rules.json`，
> 其中 `channels.feishu.name` 是模板里的「飞书」。如果希望通道显示名保持「审阅机器人」，
> 在 apply 模板之后再跑一次 `setup-review-bot.sh` 即可（幂等，不会重复建密钥）。
> 顺序反过来也没问题：`setup-review-bot.sh` 只补/改 `channels.feishu` 这一段，其它规则原样保留。

---

## 2. 两个阶段的「拿 open_id」

任一途径都行（open_id 是你在**对应应用**下的身份，两个应用各有一个）：

| 途径 | 命令 |
|---|---|
| 审阅机器人脚本自动扫码 | `setup-review-bot.sh ... --login` → 打印 `OPEN_ID=ou_xxx` |
| 任务发布机器人未授权回复 | 第一次装完（不带 `--owner`）给它发消息，它回「⛔ 未授权 … 你的 open_id：`ou_xxx`」 |
| 任务发布机器人日志 | `~/.dsh-lark-bot/logs/bot-<日期>.log` 里「忽略未授权发送者 ou_...」 |
| 飞书控制台 / 通讯录 API | 开放平台「通讯录」或联系管理员查 |

拿到后：

- 审阅机器人：`--owner <OPEN_ID>`（写 `config.json` 的 `channels.feishu.user` 和 `rules.json` 的 `answerers`）
- 任务发布机器人：`--owner <OPEN_ID>`（写 `config.json` 的 `ownerOpenId` + `allowedUsers`）

---

## 3. App Secret 怎么传（不要贴命令行参数）

```bash
# 推荐：环境变量 → stdin（不留 shell 历史、不进进程列表）
printf '%s' "$FEISHU_APP_SECRET" | bash feishu/setup-task-bot.sh --profile tieka-task --app-id cli_xxx

# 或直接运行，按提示粘贴（输入不回显）
bash feishu/setup-task-bot.sh --profile tieka-task --app-id cli_xxx
```

`lark-cli` 会把 Secret 存进自己的本地凭据存储（`~/.lark-cli` 及其系统凭据），不会写进本仓库任何文件。
轮换 Secret 后：开放平台重置 Secret → 重跑脚本并加 `--force-profile`（同名同 App ID 时脚本默认跳过，
不会自动更新 Secret）。

---

## 4. `--dry-run` 与沙箱测试

```bash
# 只看会做什么，不写文件、不建 profile、不装 launchd、不动 autoloop
bash feishu/setup-task-bot.sh --profile tieka-task --app-id cli_xxx --dry-run
bash feishu/setup-review-bot.sh --profile tieka-review --app-id cli_xxx --owner ou_xxx --dry-run
```

想在没有副作用的临时目录里做「真实文件生成」测试，用 `TIEKA_HOME` 把家目录指到沙箱
（会同时 `export HOME`，所以 lark-cli profile / plist / 配置都落在沙箱）：

```bash
SB=$(mktemp -d)
printf 'sandbox-not-a-real-secret\n' | TIEKA_HOME="$SB" bash feishu/setup-task-bot.sh \
  --profile tieka-task --app-id cli_test --no-service
```

> 注意：沙箱里仍会调用真实的 `lark-cli`（写它自己的沙箱配置）和 `agent-autoloop`；
> 如果连它们也要隔离，把桩程序放进 PATH 最前面（见仓库开发记录，不在用户手册范围）。
> 正式安装时**一定不要**设 `TIEKA_HOME`。

---

## 5. 失败回滚

| 脚本 | 回滚方式 |
|---|---|
| `setup-task-bot.sh` | 配置有 `.bak-tieka-*` 备份；`bash bots/dsh-lark-bot/botctl.sh uninstall` 卸载 launchd；`lark-cli profile remove <profile>` 收回 profile |
| `setup-review-bot.sh` | `agent-autoloop check` 失败会**自动**把 `config.json`/`rules.json` 恢复到安装前；手动回滚 = 有备份就 `cp` 回去；`agent-autoloop key remove channel feishu` 收回通道密钥 |

排障先看 [../docs/TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md)；飞书侧（应用/权限/事件/发布）
看 [../docs/FEISHU-SETUP.md](../docs/FEISHU-SETUP.md) 最后一节「常见失败」。
