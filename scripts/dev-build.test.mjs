import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
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
  const project = { dir, sha: "", files: {}, tags: {}, snapshots: {}, latest: { tag_name: "v1.0.192", draft: false, prerelease: false, published_at: "2026-10-19T00:00:00Z" } };
  const write = (name, text) => {
    project.files[name] = text;
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  const commit = () => {
    project.sha = String(Object.keys(project.snapshots).length + 1).padStart(40, "0");
    project.snapshots[project.sha] = { ...project.files };
    return project.sha;
  };
  const git = (command, name, target) => {
    if (command === "tag") project.tags[name] = project.sha;
    else if (command === "mv") {
      write(target, project.files[name]);
      delete project.files[name];
    } else throw new Error(`Unexpected fixture command: ${command}`);
  };
  write("package.json", '{"version":"1.0.192"}');
  write("server/message-db.ts", "stable\n");
  commit();
  return Object.assign(project, { git, write, commit });
}

function runScript(project, status, args, env = {}, input) {
  const preload = join(project.dir, "fetch.mjs");
  writeFileSync(preload, `import { registerHooks } from "node:module";
    import { appendFileSync } from "node:fs";
    const project = ${JSON.stringify(project)};
    globalThis.fakeGit = (program, args) => {
      if (program !== "git") throw new Error("Unexpected process");
      appendFileSync(${JSON.stringify(join(project.dir, "git-calls"))}, JSON.stringify(args) + "\\n");
      if (args[0] === "rev-parse" && args[1] === "HEAD") return project.sha + "\\n";
      if (args[0] === "tag") return Object.keys(project.tags).sort().reverse().join("\\n");
      const ref = args.at(-1).replace(/\\^\\{commit\\}$/, "").replace(/^refs\\/tags\\//, "");
      if (args[0] === "rev-parse") {
        if (!project.tags[ref]) throw new Error("Missing stable tag");
        return project.tags[ref] + "\\n";
      }
      if (args[0] === "ls-remote") {
        const tag = args[3].replace(/^refs\\/tags\\//, "");
        const sha = (project.remoteTags ?? project.tags)[tag];
        if (!sha) throw new Error("Missing remote stable tag");
        return project.annotated ? "f".repeat(40) + "\\trefs/tags/" + tag + "\\n" + sha + "\\trefs/tags/" + tag + "^{}\\n"
          : sha + "\\trefs/tags/" + tag + "\\n";
      }
      if (args[0] === "diff") {
        const tag = args.at(-2).replace(/^refs\\/tags\\//, "");
        const before = project.snapshots[project.tags[tag]];
        if (!before) throw new Error("Unexpected diff baseline: " + tag);
        return [...new Set([...Object.keys(before), ...Object.keys(project.files)])]
          .filter((file) => before[file] !== project.files[file]).join("\\0");
      }
      throw new Error("Unexpected git call: " + args.join(" "));
    };
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "node:child_process") return { url: "data:text/javascript,export const execFileSync = globalThis.fakeGit;", shortCircuit: true };
      return nextResolve(specifier, context);
    } });
    globalThis.fetch = async (url, options = {}) => {
      appendFileSync(${JSON.stringify(join(project.dir, "http-calls"))}, JSON.stringify([url, options.method ?? "GET"]) + "\\n");
      if (url === "https://api.github.com/repos/aiedwardyi/orbit-releases/releases/latest") {
        if (project.latestStatus === "network") throw new Error("Stable API offline");
        return Response.json(project.latest, { status: project.latestStatus ?? 200 });
      }
      const version = JSON.parse(project.files["package.json"]).version;
      if (url === "https://github.com/aiedwardyi/orbit-releases/releases/tag/v" + version && options.method === "HEAD") return new Response(null, { status: ${status} });
      if (url === "https://api.github.com/repos/aiedwardyi/Orbit/branches/review-base") return Response.json({ commit: { sha: project.tip ?? project.sha } }, { status: project.tipStatus ?? 200 });
      const page = String(url).match(/^https:\\/\\/api\\.github\\.com\\/repos\\/aiedwardyi\\/Orbit\\/releases\\?per_page=100&page=(\\d+)$/);
      if (page) return Response.json(project.pages?.[Number(page[1]) - 1] ?? [], { status: project.releasesStatus ?? 200 });
      throw new Error("Unexpected HTTP request: " + url);
    };`);
  const output = join(project.dir, "output");
  const summary = join(project.dir, "summary");
  const childEnv = { ...process.env, GITHUB_RUN_NUMBER: "45", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env };
  for (const key of ["ORBIT_URL", "ORBIT_MSG_AUTH", "ORBIT_MSG_TOKEN", "ORBIT_PANE"]) delete childEnv[key];
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, ...args], {
    cwd: project.dir,
    encoding: "utf8",
    windowsHide: true,
    env: childEnv,
    input,
  });
  return { ...result, output, summary };
}

function prepare(project, status = 200) {
  return runScript(project, status, [join(ROOT, "scripts/dev-build.mjs")]);
}

function publicationAllowed(project, ciAttempt = 1, runAttempt = 1) {
  const { prepare, publish } = workflow().jobs;
  const github = { repository: "aiedwardyi/Orbit", run_attempt: runAttempt, event: { workflow_run: {
    conclusion: "success", event: "push", run_attempt: ciAttempt, head_repository: { full_name: "aiedwardyi/Orbit" },
  } } };
  if (!runInNewContext(prepare.if, { github })) return false;
  const guard = publish.steps.find((step) => step.id === "guard");
  if (!guard) return true;
  expect(guard.env).toMatchObject({ SHA: "${{ needs.prepare.outputs.sha }}", CI_RUN_ATTEMPT: "${{ github.event.workflow_run.run_attempt }}" });
  const script = guard.run.match(/node --input-type=module - <<'EOF'\n([\s\S]*?)\nEOF/)[1];
  const result = runScript(project, 200, ["--input-type=module", "-"], { SHA: project.sha, CI_RUN_ATTEMPT: String(ciAttempt), GITHUB_RUN_ATTEMPT: String(runAttempt) }, script);
  expect(result.status, result.stderr).toBe(0);
  for (const step of publish.steps.filter((entry) => /gh release (create|delete)/.test(entry.run ?? ""))) {
    expect(step.if).toBe("steps.guard.outputs.publish == 'true'");
  }
  return readFileSync(result.output, "utf8").trim() === "publish=true";
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
    if (status === 404) {
      project.git("tag", "v1.0.191");
      project.latest.tag_name = "v1.0.191";
    }
    project.write("src/ui.ts", "changed\n");
    const sha = project.commit();
    const result = prepare(project, status);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(result.output, "utf8")).toBe(`sha=${sha}\nversion=${version}\nheld=false\n`);
  });

  it("uses the published stable tag and ignores dev tags", () => {
    const project = fixture();
    project.git("tag", "v1.0.191");
    project.write("server/message-db.ts", "new stable format\n");
    project.commit();
    project.git("tag", "v1.0.192");
    project.git("tag", "v99.0.0-dev.1");
    project.annotated = true;
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
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(result.output, "utf8")).toContain("held=true");
    expect(readFileSync(result.summary, "utf8")).toContain("Stable release probe failed: 503");
  });

  it("holds an unpublished newer stable tag with a format change and publication 404", () => {
    const project = fixture();
    project.git("tag", "v1.0.192");
    project.write("server/message-db.ts", "unpublished format\n");
    project.write("package.json", '{"version":"1.0.193"}');
    project.commit();
    project.git("tag", "v1.0.193");
    const result = prepare(project, 404);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(result.output, "utf8")).toContain("held=true");
    expect(readFileSync(result.output, "utf8")).toContain("version=1.0.193-dev.45");
    expect(readFileSync(result.summary, "utf8")).toContain("Format changes since v1.0.192");
    const calls = readFileSync(join(project.dir, "git-calls"), "utf8").trim().split("\n").map(JSON.parse);
    expect(calls.find((args) => args[0] === "diff").at(-2)).toBe("refs/tags/v1.0.192");
  });

  it.each([404, 503, "network"])("holds when the latest published stable cannot be verified: %s", (status) => {
    const project = fixture();
    project.git("tag", "v1.0.192");
    project.latestStatus = status;
    const result = prepare(project, 404);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(result.output, "utf8")).toContain("held=true");
    expect(readFileSync(result.summary, "utf8")).toMatch(/stable/i);
  });

  it.each([
    { draft: true }, { prerelease: true }, { published_at: null }, { tag_name: "v1.0.193-dev.1" },
  ])("holds invalid published stable metadata: %j", (metadata) => {
    const project = fixture();
    project.git("tag", "v1.0.192");
    Object.assign(project.latest, metadata);
    const result = prepare(project);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(result.output, "utf8")).toContain("held=true");
    expect(readFileSync(result.summary, "utf8")).toContain("Cannot verify published stable release");
  });

  it.each(["missing", "moved", "annotated moved"])("holds an unverifiable source tag: %s", (kind) => {
    const project = fixture();
    project.git("tag", "v1.0.192");
    project.remoteTags = kind === "missing" ? {} : { "v1.0.192": "e".repeat(40) };
    project.annotated = kind === "annotated moved";
    const result = prepare(project);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(result.output, "utf8")).toContain("held=true");
    expect(readFileSync(result.summary, "utf8")).toMatch(/stable tag/i);
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
    expect(publicationAllowed(fixture())).toBe(true);
  });

  it.each([[2, 1], [1, 2]])("rejects reruns with CI attempt %s and dev attempt %s", (ciAttempt, runAttempt) => {
    expect(publicationAllowed(fixture(), ciAttempt, runAttempt)).toBe(false);
  });

  it("rejects a source superseded while the Windows build was running", () => {
    const project = fixture();
    project.tip = "e".repeat(40);
    expect(publicationAllowed(project)).toBe(false);
  });

  it.each(["published", "draft", "later page"])("rejects a duplicate source SHA in a %s dev release", (kind) => {
    const project = fixture();
    const release = { tag_name: "v1.0.193-dev.44", target_commitish: project.sha, prerelease: true, draft: kind === "draft" };
    project.pages = kind === "later page" ? [Array.from({ length: 100 }, (_, n) => ({ ...release, tag_name: `v1.0.193-dev.${n + 1}`, target_commitish: "e".repeat(40) })), [release]] : [[release]];
    expect(publicationAllowed(project)).toBe(false);
  });

  it.each(["tip", "releases"])("rejects publishing when the %s API fails", (api) => {
    const project = fixture();
    project[api === "tip" ? "tipStatus" : "releasesStatus"] = 503;
    expect(publicationAllowed(project)).toBe(false);
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
    expect(runs).toContain('test("^v\\\\d+\\\\.\\\\d+\\\\.\\\\d+-dev\\\\.\\\\d+$")');
    expect(runs).toContain(".[3:][].tag_name");
    expect(runs).toContain("--cleanup-tag --yes");
    expect(runs.indexOf("gh release create")).toBeLessThan(runs.indexOf("gh release upload"));
    expect(runs.indexOf("gh release upload")).toBeLessThan(runs.indexOf("--draft=false"));
    expect(runs.indexOf(".isPrerelease and (.isDraft | not)")).toBeLessThan(runs.indexOf("gh release delete"));
  });

  it.each(["v2.0.0-alpha.1-dev.notes", "v1.0.193-dev.1.notes", "other-v1.0.193-dev.1", "v1.0.193-dev.notes"])("never retains %s as a generated dev tag", (tag) => {
    const step = workflow().jobs.publish.steps.find((entry) => entry.name === "Keep the newest three dev prereleases");
    const pattern = new RegExp(JSON.parse(step.run.match(/test\(("(?:\\.|[^"\\])*")\)/)[1]));
    const releases = [4, 3, 2, 1].map((n) => ({ tag_name: `v1.0.193-dev.${n}`, prerelease: true, draft: false, published_at: n }));
    releases.push({ tag_name: tag, prerelease: true, draft: false, published_at: 0 });
    const selected = releases.filter((release) => release.prerelease && !release.draft && pattern.test(release.tag_name))
      .sort((a, b) => b.published_at - a.published_at).slice(3).map((release) => release.tag_name);
    expect(selected).toEqual(["v1.0.193-dev.1"]);
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
