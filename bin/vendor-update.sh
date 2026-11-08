#!/usr/bin/env bash
# 更新 vendor/agent-autoloop 到上游最新 main，并重新应用本套件的离线补丁。
# 需要网络 + git + rsync + patch；更新完请自己 review 并发版。
#
# 用法：bash bin/vendor-update.sh [--dry-run]
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
KIT_DIR="$(cd "$SELF_DIR/.." && pwd)"
VENDOR="$KIT_DIR/vendor/agent-autoloop"
UPSTREAM="${AGENT_AUTOLOOP_UPSTREAM:-https://github.com/KKKKhazix/agent-autoloop}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say() { printf '%s\n' "$*"; }
fail() { printf '❌  %s\n' "$*" >&2; exit 1; }

[ -d "$VENDOR" ] || fail "找不到 $VENDOR"
[ -f "$VENDOR/tieka-vendor.patch" ] || fail "找不到补丁：$VENDOR/tieka-vendor.patch"
for c in git rsync patch node; do command -v "$c" >/dev/null 2>&1 || fail "需要 $c"; done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/tieka-vendor-update.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

say "▸ 拉取上游：$UPSTREAM"
git clone --quiet --depth 1 "$UPSTREAM" "$TMP/src" || fail "clone 失败（网络？）"
COMMIT="$(git -C "$TMP/src" rev-parse HEAD)"
say "  上游 HEAD：$COMMIT"

if [ "$DRY" = 1 ]; then
  say "（--dry-run）将执行：rsync 覆盖 $VENDOR、应用补丁、更新 .tieka-vendor.json 为 $COMMIT"
  exit 0
fi

# 1) 同步上游文件；保留本套件的补丁与元数据文件
say "▸ 同步文件到 vendor（保留 tieka-vendor.patch / .tieka-vendor.json）"
rsync -a --delete \
  --exclude '.git' --exclude '.github' \
  --exclude 'tieka-vendor.patch' --exclude '.tieka-vendor.json' \
  "$TMP/src/" "$VENDOR/" || fail "rsync 失败"

# 2) 应用补丁（打不上说明上游改了被 patch 的文件，需要人工 rebase 补丁）
say "▸ 应用离线补丁"
if ! patch -p1 -d "$VENDOR" < "$VENDOR/tieka-vendor.patch"; then
  fail "补丁打不上：上游改了 install.sh 或 host/version.ts，请人工更新 vendor/agent-autoloop/tieka-vendor.patch 后重跑"
fi

# 3) 更新元数据
say "▸ 更新 .tieka-vendor.json"
COMMIT="$COMMIT" SOURCE="$UPSTREAM" VENDOR="$VENDOR" node -e '
const fs = require("fs");
const path = require("path");
const p = path.join(process.env.VENDOR, ".tieka-vendor.json");
let meta = {};
try { meta = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
meta.commit = process.env.COMMIT;
meta.source = process.env.SOURCE;
meta.vendoredAt = new Date().toISOString().slice(0, 10);
meta.release = meta.release || null;
fs.writeFileSync(p, JSON.stringify(meta, null, 2) + "\n");
console.log("  commit=" + meta.commit + " vendoredAt=" + meta.vendoredAt);
' || fail "写 .tieka-vendor.json 失败"

# 4) 基本校验
sh -n "$VENDOR/install.sh" || fail "vendor install.sh 语法错误"
if ! node --experimental-strip-types -e "import(process.argv[1]).then(m => console.log('  versionLine → ' + m.versionLine()))" \
  "$VENDOR/host/version.ts" 2>/dev/null; then
  printf '⚠️  版本自检失败（不影响安装，可手动验证：node --experimental-strip-types -e ...）\n' >&2
fi

say ""
say "✅ 已更新到 $COMMIT"
say "下一步：review 变更 → git add vendor && git commit -m \"vendor: 更新 agent-autoloop 快照到 ${COMMIT:0:8}\""
say "        重新打包（zip/GitHub）后，目标机器跑 bash bin/install-autoloop.sh --update"
