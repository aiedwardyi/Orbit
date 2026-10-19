import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FORMAT_PATHS = [
  "server/thread-sync-v2*.ts",
  "server/profile-sync.ts",
  "server/device-sync.ts",
  "server/memory-sync.ts",
  "server/picture-sync.ts",
  "server/google-sync.ts",
  "server/drive-mirror.ts",
  "server/drive-own-ids.ts",
  "server/sync-roots.ts",
  "server/message-db.ts",
  "shared/bot-avatar.ts",
];

const FORMAT_PATTERNS = FORMAT_PATHS.map((path) => new RegExp(`^${path.replaceAll(".", "\\.").replaceAll("*", "[^/]*")}$`));
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function devVersion(pkgVersion, published, run) {
  if (!STABLE_VERSION.test(pkgVersion)) throw new Error("Package version must be stable");
  if (!/^[1-9]\d*$/.test(String(run))) throw new Error("Invalid workflow run number");
  const [major, minor, patch] = pkgVersion.split(".");
  const base = published ? `${major}.${minor}.${Number(patch) + 1}` : pkgVersion;
  return `${base}-dev.${run}`;
}

export function heldBy(changedFiles) {
  return changedFiles.filter((file) => !file.endsWith(".test.ts") && FORMAT_PATTERNS.some((pattern) => pattern.test(file)));
}

async function prepare() {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true });
  const sha = git("rev-parse", "HEAD").trim();
  const pkgVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  devVersion(pkgVersion, false, process.env.GITHUB_RUN_NUMBER);
  const stableTag = git("tag", "--list", "v*", "--sort=-v:refname").trim().split("\n")
    .find((tag) => tag.startsWith("v") && STABLE_VERSION.test(tag.slice(1)));
  // Renames must still report the removed format path.
  const changedFiles = stableTag ? git("diff", "--name-only", "--no-renames", "-z", stableTag, sha).split("\0").filter(Boolean) : [];
  const heldFiles = heldBy(changedFiles);
  const held = !stableTag || heldFiles.length > 0;
  const summary = !stableTag ? "## Dev build held\n\nMissing stable tag.\n"
    : held ? `## Dev build held\n\nFormat changes since ${stableTag}:\n${heldFiles.map((file) => `- \`${file}\``).join("\n")}\n`
      : `## Dev build ready\n\nNo format changes since ${stableTag}.\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);

  const response = await fetch(`https://github.com/aiedwardyi/orbit-releases/releases/tag/v${pkgVersion}`, {
    method: "HEAD",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 404) throw new Error(`Stable release probe failed: ${response.status}`);
  const version = devVersion(pkgVersion, response.ok, process.env.GITHUB_RUN_NUMBER);
  const output = `sha=${sha}\nversion=${version}\nheld=${held}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  console.log(output.trimEnd());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepare();
