# agent-autoloop 技能手册（上游快照）

本目录是 **agent-autoloop** 项目自带 Skill 的只读副本，供 DSH / Claude Code / Codex 在配置和使用中台时查阅。

- 上游：<https://github.com/KKKKhazix/agent-autoloop>（MIT）
- 上游技能目录：<https://github.com/KKKKhazix/agent-autoloop/tree/main/skills/agent-autoloop>
- 许可：MIT，见本目录 [LICENSE](LICENSE)（Copyright (c) 2026 数字生命卡兹克）
- 快照来源：本机已安装的 agent-autoloop（`agent-autoloop --version` = `1.0.0`，提交 `4567e51`）里的
  `app/skills/agent-autoloop/SKILL.md`；与本套件安装的上游版本可能存在措辞差异。
- 改动：`SKILL.md` 内容未改；新增了本 README 和上游 `LICENSE` 文件。

## 怎么用

- **给 DSH 用**：`cp -R skills/agent-autoloop ~/.dsh/skills/`（安装单第 5.5 步会连同其它 skills 一起复制）。
- **给 Claude Code 用**：`cp -R skills/agent-autoloop ~/.claude/skills/`。
- **给 Codex 用**：`cp -R skills/agent-autoloop ~/.codex/skills/`。
- **人看**：直接读 [SKILL.md](SKILL.md)——怎么加规则、接事件来源、接 Agent、接通道、写处理手册、
  部署到服务器都在里面。

## 注意

`SKILL.md` 里有些相对链接指向上游仓库的其它文件（`docs/protocol.md`、`examples/recipes/` 等），
本目录没有一并收录：点不开时去上游仓库看，或看本套件的
[configs/autoloop/rules.example.md](../../configs/autoloop/rules.example.md) 与
[docs/ENVIRONMENT.md](../../docs/ENVIRONMENT.md)。

## 更新

上游更新后，直接从安装目录重新复制即可（会覆盖 `SKILL.md`）：

```bash
cp -p ~/.agent-autoloop/app/skills/agent-autoloop/SKILL.md skills/agent-autoloop/SKILL.md
```

或者从上游仓库 `skills/agent-autoloop/` 复制。LICENSE 来自上游仓库根目录。
