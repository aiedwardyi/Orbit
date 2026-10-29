import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { missingRealFixture } from "./check-real-fixtures.mjs";

const seam = { path: "server/usage-refresh.ts", tests: ["server/usage-refresh.test.ts"], status: "covered" };
const fixture = "test/fixtures/recorded/claude/usage.json";
const recording = JSON.stringify({ stamp: { engine: "claude", cliVersion: "2.1.310", recordedAt: "2026-10-29", sourcePc: "work" }, reply: {} });
const imports = 'import { createUsageRefresh } from "./usage-refresh.ts";';
const loader = 'JSON.parse(readFileSync(new URL("../test/fixtures/recorded/claude/usage.json", import.meta.url), "utf8"));';
const check = (source, changed = [seam.path], body = recording, seams = [seam]) => missingRealFixture(seams, changed, (file) =>
  file === "server/usage-refresh.test.ts" ? source : file === fixture ? body : null);

describe("recorded engine fixture gate", () => {
  it("rejects a touched seam whose tests only invent replies", () => {
    expect(check(`${imports} createUsageRefresh({ rpc: async () => ({}) });`)).toBe(
      "server/usage-refresh.ts: missing test/fixtures/recorded/<engine>/<name>.json loaded by a seam test",
    );
  });

  it("accepts an existing test that loads a stamped recording", () => {
    expect(check(imports + loader)).toBeNull();
  });

  it("accepts a changed test without requiring it in the manifest", () => {
    expect(check(imports + loader, [seam.path, "server/usage-refresh.test.ts"], recording, [{ ...seam, tests: [] }])).toBeNull();
  });

  it("leaves pending seams alone until touched", () => {
    const pending = [{ ...seam, status: "pending" }];
    expect(check(null, ["README.md"], recording, pending)).toBeNull();
    expect(check(null, [seam.path], recording, pending)).toContain(seam.path);
    expect(check(imports + loader, [seam.path], recording, pending)).toBeNull();
  });

  it("requires the test to import the seam", () => {
    expect(check(loader)).toContain(seam.path);
    expect(check('import type { Result } from "./usage-refresh.ts";' + loader)).toContain(seam.path);
  });

  it.each([
    `${imports} // ${loader}`,
    `${imports} /* ${loader} */`,
    `${imports} const note = ${JSON.stringify(loader)};`,
    `${imports} new URL("../test/fixtures/recorded/claude/usage.json", import.meta.url);`,
    `${imports} readFileSync(new URL("./usage-refresh.fixture.json", import.meta.url), "utf8");`,
    `${imports} readFileSync(new URL("../test/fixtures/recorded/../invented.json", import.meta.url), "utf8");`,
    `${imports} readFileSync("test/fixtures/recorded/../invented.json", "utf8");`,
  ])("ignores mentions that do not load a recorded file: %s", (source) => {
    expect(check(source)).toContain(seam.path);
  });

  it.each([
    null,
    "not json",
    "{}",
    JSON.stringify({ stamp: { engine: "claude" } }),
    JSON.stringify({ stamp: JSON.parse(recording).stamp }),
  ])("rejects missing, unstamped or reply-less recordings: %s", (body) => {
    expect(check(imports + loader, [seam.path], body)).toContain(seam.path);
  });

  it.each([
    'import reply from "../test/fixtures/recorded/claude/usage.json";',
    'readFileSync("test/fixtures/recorded/claude/usage.json", "utf8");',
    'await fs.readFile(new URL("../test/fixtures/recorded/claude/usage.json", import.meta.url), "utf8");',
    'require("../test/fixtures/recorded/claude/usage.json");',
    'await import("../test/fixtures/recorded/claude/usage.json");',
  ])("recognizes fixture loaders: %s", (source) => {
    expect(check(imports + source)).toBeNull();
  });

  it("rejects deleted seam tests", () => {
    expect(check(null)).toContain(seam.path);
  });

  it("accepts the repository usage recordings when both usage seams change", () => {
    const read = (file) => {
      try {
        return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      } catch {
        return null;
      }
    };
    const seams = JSON.parse(read("scripts/engine-seams.json"));
    expect(missingRealFixture(seams, seams.filter((entry) => entry.status === "covered").map((entry) => entry.path), read)).toBeNull();
  });
});
