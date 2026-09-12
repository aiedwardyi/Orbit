import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { grokIsAuthenticated } from "./grok.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch HOME whose `.grok` may or may not hold the CLI's auth.json. */
function scratchHome(signedIn: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-grok-auth-"));
  scratchDirs.push(dir);
  mkdirSync(join(dir, ".grok"), { recursive: true });
  if (signedIn) writeFileSync(join(dir, ".grok", "auth.json"), "{}");
  return dir;
}

describe("Grok subscription authentication", () => {
  it("reads auth.json out of GROK_HOME", () => {
    expect(grokIsAuthenticated({ GROK_HOME: join(scratchHome(true), ".grok") })).toBe(true);
    expect(grokIsAuthenticated({ GROK_HOME: join(scratchHome(false), ".grok") })).toBe(false);
  });

  it("falls back to HOME then USERPROFILE", () => {
    expect(grokIsAuthenticated({ HOME: scratchHome(true) })).toBe(true);
    expect(grokIsAuthenticated({ HOME: scratchHome(false) })).toBe(false);
    expect(grokIsAuthenticated({ USERPROFILE: scratchHome(true) })).toBe(true);
    expect(grokIsAuthenticated({ USERPROFILE: scratchHome(false) })).toBe(false);
  });

  // The probe and the config reader have to land on the same home, or Orbit
  // reports a signed-in engine that cannot run and never offers the login card.
  it("answers from the instance env, not the real homedir", () => {
    const signedIn = { GROK_HOME: join(scratchHome(true), ".grok") };
    const signedOut = { GROK_HOME: join(scratchHome(false), ".grok") };
    expect(grokIsAuthenticated(signedIn)).not.toBe(grokIsAuthenticated(signedOut));
  });
});
