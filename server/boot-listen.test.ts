import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(here, "index.ts"), "utf8");

describe("harness listen is not blocked on engine describe", () => {
  it("does not await defaultSelection before server.listen", () => {
    const bootAssign = index.indexOf("bootSelection = await defaultSelection()");
    expect(bootAssign).toBe(-1);
    expect(index).toMatch(/void defaultSelection\(\)/);
    expect(index).toMatch(/function describeInstances\(/);
    const listenAt = index.indexOf("server.listen(");
    const scheduleAt = index.indexOf("void defaultSelection()");
    expect(listenAt).toBeGreaterThan(-1);
    expect(scheduleAt).toBeGreaterThan(-1);
    expect(scheduleAt).toBeLessThan(listenAt);
  });

  it("still resolves a default engine when creating a bot", () => {
    expect(index).toMatch(/const selection = await defaultSelection\(\)/);
    expect(index).toMatch(/selection = await defaultSelection\(\)/);
  });
});
