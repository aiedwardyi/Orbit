import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(here, "index.ts"), "utf8");
const teams = readFileSync(join(here, "team-routes.ts"), "utf8");
const bots = readFileSync(join(here, "bot-routes.ts"), "utf8");

describe("harness listen is not blocked on engine describe", () => {
  it("does not start defaultSelection until after listen or early attach", () => {
    const bootAssign = index.indexOf("bootSelection = await defaultSelection()");
    expect(bootAssign).toBe(-1);
    expect(index).toMatch(/void describeInstances\("refresh"\)/);
    expect(index).toMatch(/function describeInstances\(/);
    expect(index).toMatch(/currentEarlyListen\(/);
    expect(index).toMatch(/early\.setHandler\(/);
    const listenAt = index.indexOf("server.listen(");
    const attachAt = index.indexOf("early.setHandler(");
    const scheduleAt = index.indexOf('void describeInstances("refresh")');
    expect(listenAt).toBeGreaterThan(-1);
    expect(attachAt).toBeGreaterThan(-1);
    expect(scheduleAt).toBeGreaterThan(-1);
    expect(scheduleAt).toBeGreaterThan(listenAt);
    expect(scheduleAt).toBeGreaterThan(attachAt);
    const deferredAt = index.lastIndexOf("setTimeout(", scheduleAt);
    expect(deferredAt).toBeGreaterThan(attachAt);
    expect(deferredAt).toBeLessThan(scheduleAt);
    expect(index.slice(deferredAt - 32, deferredAt)).toContain("serverServing.then");
  });

  it("seeds automatic availability from saved probes before serving", () => {
    const seedAt = index.indexOf("rememberAutomaticAvailability(registry.describeSaved())");
    expect(seedAt).toBeGreaterThan(-1);
    expect(seedAt).toBeLessThan(index.indexOf("early.setHandler("));
    expect(seedAt).toBeLessThan(index.indexOf("server.listen("));
  });

  it("still resolves a default engine when creating a bot", () => {
    expect(teams).toMatch(/const selection = await defaultSelection\(\)/);
    expect(bots).toMatch(/selection = await defaultSelection\(\)/);
  });
});
