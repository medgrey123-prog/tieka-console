# vendor/agent-autoloop — 上游快照（离线安装用）

本目录是 [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 的**固定版本快照**，
让「铁卡老弟」安装包在**不联网、不依赖 git** 的机器上也能装出中台。

| 项 | 值 |
|---|---|
| 上游 | https://github.com/KKKKhazix/agent-autoloop |
| 快照 commit | `f62efedd3548fc21aad4d43454b17efc758ff705`（main，2026-11-09） |
| 快照日期 | 2026-11-09 |
| 许可 | MIT，见 [LICENSE](LICENSE)（版权归上游作者） |
| 文件数/体积 | 244 个文件 / 约 2.0 MB（不含 `.git`） |

## 怎么被使用

- `bin/install-autoloop.sh` **默认**用本目录安装：

  ```bash
  bash bin/install-autoloop.sh                 # 从 vendor 快照复制到 ~/.agent-autoloop/app
  bash bin/install-autoloop.sh --update        # 刷新快照安装（不拉上游）
  ```

  安装脚本会给上游 `install.sh` 传 `AGENT_AUTOLOOP_VENDOR=1`，上游脚本走「本地复制」分支；
  复制完成后照常链接 CLI、`init`、注册系统服务。
- 想改用别处来源（联网上游 / 内网 git / 另一个本地目录）：设置 `AGENT_AUTOLOOP_REPO` 即可覆盖。
- 安装后 `agent-autoloop --version` 显示的是本快照的 release/commit（来自 `.tieka-vendor.json`）。

> 注意：**不要**在目标机器上用 `agent-autoloop update` 升级 vendor 安装——它没有 `.git`。
> 升级方式 = 在本仓库跑 `bash bin/vendor-update.sh` 换新快照，然后分发，目标机器跑
> `bash bin/install-autoloop.sh --update`。

## 相对上游改了什么

补丁在 [`tieka-vendor.patch`](tieka-vendor.patch)（可用 `patch -p1 -d vendor/agent-autoloop < tieka-vendor.patch` 复现）：

| 文件 | 改动 | 原因 |
|---|---|---|
| `install.sh` | 新增 `AGENT_AUTOLOOP_VENDOR=1` 分支：`rm -rf $APP` 后从本地快照 `tar` 复制，不 clone、不联网；该模式下不强制要求 git | 离线安装；快照没有 `.git`，上游原逻辑会 `git clone` 本地路径失败 |
| `host/version.ts` | 没有 `.git` 时读取同目录 `.tieka-vendor.json` 的 `commit`/`release`（没有该文件仍回退 `dev`） | 让 `agent-autoloop --version` 显示真实快照版本，而不是 `dev` |

新增文件：

- `.tieka-vendor.json`：快照元数据（commit / release / source / vendoredAt）
- `tieka-vendor.patch`：上述两处改动的可复现补丁

其它上游文件**原样保留**（含 README / INSTALL / docs / examples / plugins / kernel / cli / host），方便查文档和排障；
本仓库整体 MIT，上游版权归其作者。

## 更新快照（需要网络）

```bash
bash bin/vendor-update.sh
# 或者手动：
git clone --depth 1 https://github.com/KKKKhazix/agent-autoloop /tmp/aa
rsync -a --delete --exclude .git --exclude .github \
  --exclude tieka-vendor.patch --exclude .tieka-vendor.json \
  /tmp/aa/ vendor/agent-autoloop/
patch -p1 -d vendor/agent-autoloop < vendor/agent-autoloop/tieka-vendor.patch
# 更新 .tieka-vendor.json 的 commit / vendoredAt
git add vendor && git commit -m "vendor: 更新 agent-autoloop 快照到 <commit>"
```

`bin/vendor-update.sh` 会自动做这些，并在补丁打不上时停止（说明上游改了被 patch 的文件，需要人工重做补丁）。
