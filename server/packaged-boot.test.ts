import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const boot = readFileSync(join(here, "packaged-boot.ts"), "utf8");

describe("packaged boot listens before importing the fat harness", () => {
  it("starts early listen, then dynamically imports index", () => {
    const listenAt = boot.indexOf("startEarlyListen(");
    const importAt = boot.search(/await import\(\s*["'].*index\.(ts|js)["']\s*\)/);
    expect(listenAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(-1);
    expect(listenAt).toBeLessThan(importAt);
  });
});
