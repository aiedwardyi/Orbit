import { createHash } from "node:crypto";
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
  const { WINK_GOOGLE_CLIENT_ID, WINK_GOOGLE_CLIENT_SECRET, WINK_GOOGLE_WEB_CLIENT_ID: _webClientId, WINK_TEAM_RELAY: _teamRelay, WINK_TEAM_OWNER: _teamOwner, ...rest } = process.env;
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

  it("adds the web client id for phone sign-in only when set", () => {
    const both = { WINK_GOOGLE_CLIENT_ID: "id", WINK_GOOGLE_CLIENT_SECRET: "secret" };
    expect(JSON.parse(readFileSync(bake({ ...both, WINK_GOOGLE_WEB_CLIENT_ID: " web " }), "utf8"))).toEqual({ id: "id", secret: "secret", webId: "web" });
    expect(JSON.parse(readFileSync(bake(both), "utf8"))).toEqual({ id: "id", secret: "secret" });
    expect(existsSync(bake({ WINK_GOOGLE_WEB_CLIENT_ID: "web" }))).toBe(false);
  });

  it("takes the web client id from the release variable", () => {
    const release = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    expect(release).toContain("WINK_GOOGLE_WEB_CLIENT_ID: ${{ vars.WINK_GOOGLE_WEB_CLIENT_ID }}");
    expect(release).toContain("WINK_TEAM_RELAY: ${{ vars.WINK_TEAM_RELAY }}");
    expect(release).toContain("WINK_TEAM_OWNER: ${{ secrets.WINK_TEAM_OWNER }}");
  });

  it("bakes the team owner as a hash, never the email", () => {
    const both = { WINK_GOOGLE_CLIENT_ID: "id", WINK_GOOGLE_CLIENT_SECRET: "secret" };
    const email = "Owner@Example.com";
    const hash = createHash("sha256").update(email.toLowerCase()).digest("hex");
    const baked = JSON.parse(readFileSync(bake({ ...both, WINK_TEAM_OWNER: ` ${email} ` }), "utf8"));
    expect(baked.teamOwner).toBe(hash);
    expect(JSON.stringify(baked)).not.toContain(email);
    expect(JSON.stringify(baked)).not.toContain(email.toLowerCase());
    expect(existsSync(bake({ WINK_TEAM_OWNER: email }))).toBe(false);
  });

  it("bakes the team relay only beside a Google client", () => {
    const both = { WINK_GOOGLE_CLIENT_ID: "id", WINK_GOOGLE_CLIENT_SECRET: "secret" };
    expect(JSON.parse(readFileSync(bake({ ...both, WINK_TEAM_RELAY: " wink.example " }), "utf8"))).toEqual({ id: "id", secret: "secret", teamRelay: "wink.example" });
    expect(JSON.parse(readFileSync(bake(both), "utf8"))).toEqual({ id: "id", secret: "secret" });
    expect(existsSync(bake({ WINK_TEAM_RELAY: "wink.example" }))).toBe(false);
  });
});
