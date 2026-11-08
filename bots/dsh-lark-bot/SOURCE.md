# 来源与改动说明（vendored）

本目录是 **dsh-lark-bot** 的随套件副本（vendored），不是本仓库从零写的代码。

## 上游来源

| 项 | 值 |
|---|---|
| 项目 | dsh-lark-bot（用飞书 / Lark 消息遥控 DeepSeek Harness 的常驻机器人） |
| 上游位置 | DeepSeek Harness 仓库的 `plugins/dsh-lark-bot/` 目录 |
| 上游版本 | `package.json` v1.0.0；本副本对应 2026-10-23 的上游快照 |
| 许可 | MIT，版权归上游作者；本仓库根目录 [LICENSE](../../LICENSE) 同时覆盖本副本 |
| 复制日期 | 2026-11-08 |

## 复制范围

保留：

- `bot.mjs`（主程序，零第三方依赖）
- `botctl.sh`（macOS launchd 管理）、`botctl.ps1`（Windows 管理）
- `install-windows.ps1`（上游 Windows 一键安装，保留但本套件未做端到端验证）
- `package.json`
- `docs/本次跑通实录-macOS.md`（上游跑通记录，已脱敏，作设计与踩坑参考）

**未复制**（避免把本机私密信息带进仓库）：

- `config.json` / `config.json.bak-*`（含本机 App 凭证与真实 open_id）
- `logs/`、`node_modules/`、`.git/`
- `docs/*.html`（由上游 markdown 生成的派生物）、`tools/build-doc.py`

本目录内所有配置一律用占位符（`<APP_ID>`、`<OPEN_ID>`、`$HOME`），不含任何真实密钥、
open_id、本机用户名或用户绝对路径。

## 本套件对上游文件做的改动

| 文件 | 改动 | 原因 |
|---|---|---|
| `bot.mjs` | 配置路径改为：`$DSH_LARK_BOT_CONFIG` > `$HOME/.dsh-lark-bot/config.json` > 同目录 `config.json`；启动、`--init`、`--doctor` 共用同一路径 | 套件约定配置与运行状态都在 `~/.dsh-lark-bot/`（`verify-install.sh` 也按此检查），同时兼容上游“配置在源码目录”的布局 |
| `botctl.sh` | launchd label 改为通用名 `com.tieka.dsh-lark-bot`（可用 `DSH_LARK_BOT_LABEL` 覆盖）；写 plist 时对路径做 XML 转义；文件头注明套件来源 | 原 label 含本机用户名；仓库路径可能带空格/特殊字符，plist 必须转义 |
| `install-windows.ps1` | 收尾提示里的文档指引改指向本套件 `docs/FEISHU-SETUP.md` | 上游 Windows 手册未随本套件分发 |
| `README.md` | 重写为本套件用法（安装入口、配置路径、两阶段白名单引导、排错） | 面向另一台机器上的 DSH 用户/代理 |
| `docs/本次跑通实录-macOS.md` | 顶部加“历史文档/国内版以 FEISHU-SETUP 为准”提示；消息/会话/open_id 打码 | 脱敏 + 避免国际版信息误导 |
| `config.example.json` | **新增**。全部用 `$HOME` 占位，由 `feishu/setup-task-bot.sh` 展开后写入 `~/.dsh-lark-bot/config.json` | 上游靠 `--init` 现场探测；套件改为模板化、可复现 |

除上表外，代码逻辑未改动。

## 升级上游版本

1. 用新版覆盖 `bot.mjs` / `botctl.sh` / `botctl.ps1` / `install-windows.ps1` / `package.json`；
2. 重新应用上表的 3 处代码改动（配置路径、label/XML 转义、文档指引）；
3. **不要覆盖** `config.example.json` 与 `~/.dsh-lark-bot/config.json`；
4. 跑 `bash feishu/setup-task-bot.sh --profile <name> --app-id <id>` 复检，`bash botctl.sh doctor` 全绿即完成。
