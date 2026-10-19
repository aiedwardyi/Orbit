import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { isNewerVersion } from "../electron/updater-coordinator.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => {
  if (dirname(dir) !== tmpdir()) throw new Error("Temporary directory escaped the test root");
  rmSync(dir, { recursive: true, force: true });
}));

function workflow() {
  const text = readFileSync(join(ROOT, ".github/workflows/dev-build.yml"), "utf8");
  return { text, ...parse(text) };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wink-dev-build-"));
  dirs.push(dir);
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  const write = (name, text) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  write("package.json", '{"version":"1.0.192"}');
  write("server/message-db.ts", "stable\n");
  commit();
  return { dir, git, write, commit };
}

function prepare(project, status = 200) {
  const preload = join(project.dir, "fetch.mjs");
  writeFileSync(preload, `globalThis.fetch = async (url, options) => {
    if (!url.endsWith("/releases/tag/v1.0.192") || options.method !== "HEAD") throw new Error("Unexpected probe");
    return new Response(null, { status: ${status} });
  };`);
  const output = join(project.dir, "output");
  const summary = join(project.dir, "summary");
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, join(ROOT, "scripts/dev-build.mjs")], {
    cwd: project.dir,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GITHUB_RUN_NUMBER: "45", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
  });
  return { ...result, output, summary };
}

describe("devVersion", () => {
  it("bumps a published package to the next patch", async () => {
    const { devVersion } = await import("./dev-build.mjs");
    expect(devVersion("1.0.192", true, 45)).toBe("1.0.193-dev.45");
  });

  it("keeps an unpublished package version", async () => {
    const { devVersion } = await import("./dev-build.mjs");
    expect(devVersion("1.0.193", false, 46)).toBe("1.0.193-dev.46");
  });

  it("rejects a prerelease package version", async () => {
    const { devVersion } = await import("./dev-build.mjs");
    expect(() => devVersion("1.0.193-dev.1", false, 46)).toThrow(/stable/i);
  });

  it.each([0, -1, "01", "1.5"])("rejects invalid run number %s", async (run) => {
    const { devVersion } = await import("./dev-build.mjs");
    expect(() => devVersion("1.0.193", false, run)).toThrow(/run/i);
  });

  it("orders generated dev versions between their stable releases", async () => {
    const { devVersion } = await import("./dev-build.mjs");
    const versions = ["1.0.192", devVersion("1.0.192", true, 9), devVersion("1.0.193", false, 46), "1.0.193", devVersion("1.0.193", true, 1)];
    for (let i = 1; i < versions.length; i++) {
      expect(isNewerVersion(versions[i], versions[i - 1])).toBe(true);
      expect(isNewerVersion(versions[i - 1], versions[i])).toBe(false);
    }
  });
});

describe("heldBy", () => {
  it.each([
    "server/thread-sync-v2.ts", "server/thread-sync-v2-engine.ts", "server/profile-sync.ts",
    "server/device-sync.ts", "server/memory-sync.ts", "server/picture-sync.ts",
    "server/google-sync.ts", "server/drive-mirror.ts", "server/drive-own-ids.ts",
    "server/sync-roots.ts", "server/message-db.ts", "shared/bot-avatar.ts",
  ])("holds changes to %s", async (file) => {
    const { heldBy } = await import("./dev-build.mjs");
    expect(heldBy([file])).toEqual([file]);
  });

  it("ignores tests, src and files outside the format list", async () => {
    const { heldBy } = await import("./dev-build.mjs");
    expect(heldBy([
      "server/thread-sync-v2-engine.test.ts", "server/message-db.test.ts", "shared/bot-avatar.test.ts",
      "src/message-db.ts", "src/components/ChatBox.tsx", "server/config.ts", "server/nested/thread-sync-v2.ts",
    ])).toEqual([]);
  });
});

describe("dev build preparation", () => {
  it.each([[200, "1.0.193-dev.45"], [404, "1.0.192-dev.45"]])("emits pinned outputs after a %s stable probe", (status, version) => {
    const project = fixture();
    project.git("tag", "v1.0.192");
    project.write("src/ui.ts", "changed\n");
    const sha = project.commit();
    const result = prepare(project, status);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(result.output, "utf8")).toBe(`sha=${sha}\nversion=${version}\nheld=false\n`);
  });

  it("uses the newest stable tag and ignores dev tags", () => {
    const project = fixture();
    project.git("tag", "v1.0.191");
    project.write("server/message-db.ts", "new stable format\n");
    project.commit();
    project.git("tag", "v1.0.192");
    project.git("tag", "v99.0.0-dev.1");
    const result = prepare(project);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(result.output, "utf8")).toContain("held=false");
  });

  it.each(["edit", "rename"])("names held files after a format %s", (change) => {
    const project = fixture();
    project.git("tag", "v1.0.192");
    if (change === "rename") project.git("mv", "server/message-db.ts", "server/renamed.ts");
    else project.write("server/message-db.ts", "new format\n");
    project.commit();
    const result = prepare(project);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(result.output, "utf8")).toContain("held=true");
    expect(readFileSync(result.summary, "utf8")).toContain("server/message-db.ts");
  });

  it("holds when no stable tag is available", () => {
    const result = prepare(fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(result.output, "utf8")).toContain("held=true");
    expect(readFileSync(result.summary, "utf8")).toMatch(/missing stable tag/i);
  });

  it("fails closed when the stable publication probe fails", () => {
    const project = fixture();
    project.git("tag", "v1.0.192");
    const result = prepare(project, 503);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Stable release probe failed: 503");
  });
});

describe("dev build workflow", () => {
  it("accepts only green CI pushes from the same repository", () => {
    const build = workflow();
    expect(build.text).toContain("workflows: [CI]");
    expect(build.text).toContain("branches: [review-base]");
    expect(build.on.workflow_run.types).toEqual(["completed"]);
    expect(build.jobs.prepare.if).toContain("conclusion == 'success'");
    expect(build.jobs.prepare.if).toContain("event == 'push'");
    expect(build.jobs.prepare.if).toContain("head_repository.full_name == github.repository");
    expect(build.concurrency).toEqual({ group: "dev-build", "cancel-in-progress": false });
  });

  it("checks out the green SHA with tags and skips held builds", () => {
    const { prepare, windows, publish } = workflow().jobs;
    expect(prepare.steps[0].with).toMatchObject({ ref: "${{ github.event.workflow_run.head_sha }}", "fetch-depth": 0, "persist-credentials": false });
    expect(prepare.outputs).toEqual({ sha: "${{ steps.pin.outputs.sha }}", version: "${{ steps.pin.outputs.version }}", held: "${{ steps.pin.outputs.held }}" });
    expect(windows.steps[0].with.ref).toBe("${{ needs.prepare.outputs.sha }}");
    expect(windows.if).toContain("needs.prepare.outputs.held == 'false'");
    expect(publish.needs).toEqual(["prepare", "windows"]);
  });

  it("keeps the release build gates and sets the dev channel only in the workflow", () => {
    const { windows } = workflow().jobs;
    const release = parse(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8")).jobs.windows;
    for (const name of ["Clean generated output", "Bake the Google sign-in client"]) {
      expect(windows.steps.find((step) => step.name === name)).toEqual(release.steps.find((step) => step.name === name));
    }
    const runs = windows.steps.map((step) => step.run || "").join("\n");
    expect(runs).toContain('npm pkg set "version=$env:VERSION"');
    expect(runs).toContain("pnpm package:win -c.publish.channel=dev");
    for (const gate of ["packaged-boot.js", "server/index.js", "ui/index.html", "cloudflared.exe", "sha256sum", "app-update.yml", "publisherName", "node scripts/smoke-packaged-relay.mjs", "http://127.0.0.1:21987/api/health"]) {
      expect(runs).toContain(gate);
    }
    expect(runs).toContain('[ -f release/dev.yml ]');
    expect(runs).toContain('[ ! -e release/latest.yml ]');
    const artifact = windows.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(artifact.with.path.trim().split("\n")).toEqual(["release/*.exe", "release/*.exe.blockmap", "release/dev.yml"]);
    expect(artifact.with["retention-days"]).toBe(1);
  });

  it("uses the same-repository token and never names the stable release destination", () => {
    const build = workflow();
    expect(build.permissions).toEqual({ contents: "read" });
    expect(build.jobs.publish.permissions).toEqual({ contents: "write" });
    expect(build.text).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(build.text).not.toContain("RELEASES_PAT");
    expect(build.text).not.toContain("orbit-releases");
  });

  it("publishes a draft prerelease at the pinned SHA before pruning old dev releases", () => {
    const runs = workflow().jobs.publish.steps.map((step) => step.run || "").join("\n");
    expect(runs).toContain('--target "$SHA"');
    expect(runs).toContain("--draft --prerelease");
    expect(runs).toContain("--repo aiedwardyi/Orbit");
    expect(runs).toContain("--draft=false --prerelease --latest=false");
    expect(runs).toContain(".isPrerelease and (.isDraft | not)");
    expect(runs).toContain(".prerelease and (.draft | not)");
    expect(runs).toContain('test("-dev\\\\.")');
    expect(runs).toContain(".[3:][].tag_name");
    expect(runs).toContain("--cleanup-tag --yes");
    expect(runs.indexOf("gh release create")).toBeLessThan(runs.indexOf("gh release upload"));
    expect(runs.indexOf("gh release upload")).toBeLessThan(runs.indexOf("--draft=false"));
    expect(runs.indexOf(".isPrerelease and (.isDraft | not)")).toBeLessThan(runs.indexOf("gh release delete"));
  });

  it.each(["valid", "hash", "size", "empty"])("verifies %s feed bytes before publishing", (kind) => {
    const step = workflow().jobs.publish.steps.find((entry) => entry.name === "Verify the dev feed hash against the actual bytes");
    const script = step.run.match(/node --input-type=module - <<'EOF'\n([\s\S]*?)\nEOF/)[1];
    const dir = mkdtempSync(join(tmpdir(), "wink-dev-build-"));
    dirs.push(dir);
    const bytes = Buffer.from("installer");
    writeFileSync(join(dir, "Wink-setup.exe"), bytes);
    const hash = createHash("sha512").update(kind === "hash" ? "wrong" : bytes).digest("base64");
    writeFileSync(join(dir, "dev.yml"), kind === "empty" ? "version: 1.0.193-dev.45\n" : `files:\n  - url: Wink-setup.exe\n    sha512: ${hash}\n    size: ${kind === "size" ? 999 : bytes.length}\n`);
    const result = spawnSync(process.execPath, ["--input-type=module", "-"], { cwd: dir, input: script, encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(kind === "valid" ? 0 : 1);
  });
});
