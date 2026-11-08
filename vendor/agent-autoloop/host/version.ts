// Which code this is: the release tag on its commit, if any, and the commit. The tag is the one place a version number is
// written: a number in a file still names the last release on every commit after it, and goes stale wherever it's copied.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");

/** tieka-console：本地快照（vendor）没有 .git，用一个随快照带进来的元数据文件补上来源版本。 */
function vendorMeta(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, ".tieka-vendor.json"), "utf8"));
  } catch {
    return {};
  }
}

/** What was deployed, or the checkout's commit. Git says: after a gc a branch's ref is no longer a file of its own. */
export function commitOf(root = ROOT) {
  if (process.env.AGENT_AUTOLOOP_COMMIT) return process.env.AGENT_AUTOLOOP_COMMIT;
  try {
    // Only a checkout has its own .git entry; unpacked copies must not inherit a parent repository's commit.
    if (!existsSync(path.join(root, ".git"))) return vendorMeta(root).commit || "dev";
    const args = ["-C", root, "rev-parse", "HEAD"];
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "dev";
  }
}

/** The release this commit is, if it is one. A try-out tag left on the same commit gives way to the release it became. */
export function releaseOf(root = ROOT) {
  try {
    if (!existsSync(path.join(root, ".git"))) return vendorMeta(root).release || null;
    const args = ["-C", root, "tag", "--points-at", "HEAD"];
    const tags = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n");
    return tags.find((tag) => /^v\d+\.\d+\.\d+$/.test(tag)) ?? tags.find((tag) => /^v\d+\.\d+\.\d+-/.test(tag)) ?? null;
  } catch {
    return null;
  }
}

/** What other programs are told this is. */
export function versionName(root = ROOT) {
  return releaseOf(root) ?? commitOf(root).slice(0, 12);
}

export function versionLine(root = ROOT) {
  return `agent-autoloop ${releaseOf(root) ?? "未发布"}（提交 ${commitOf(root).slice(0, 12)}）`;
}
