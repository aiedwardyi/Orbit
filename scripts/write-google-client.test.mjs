import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "write-google-client.mjs");
// Built from parts so this file never matches itself.
const REAL_CLIENT = ["[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com", "GOCSPX" + "-"].join("|");

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function bake(env) {
  const dir = mkdtempSync(join(tmpdir(), "google-client-"));
  dirs.push(dir);
  const target = join(dir, "google-client.json");
  const { WINK_GOOGLE_CLIENT_ID, WINK_GOOGLE_CLIENT_SECRET, ...rest } = process.env;
  execFileSync(process.execPath, [SCRIPT, target], { env: { ...rest, ...env } });
  return target;
}

describe("google sign-in client", () => {
  it("is in no tracked file", () => {
    const found = spawnSync("git", ["grep", "-I", "-l", "-E", REAL_CLIENT], { cwd: ROOT, encoding: "utf8" });
    expect(found.status, found.stdout).toBe(1);
  });

  it("bakes into a git-ignored file", () => {
    expect(spawnSync("git", ["check-ignore", "-q", "electron/google-client.json"], { cwd: ROOT }).status).toBe(0);
  });

  it("writes both values from the env, else nothing", () => {
    const target = bake({ WINK_GOOGLE_CLIENT_ID: " id ", WINK_GOOGLE_CLIENT_SECRET: "secret" });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ id: "id", secret: "secret" });
    expect(existsSync(bake({ WINK_GOOGLE_CLIENT_ID: "id" }))).toBe(false);
  });
});
