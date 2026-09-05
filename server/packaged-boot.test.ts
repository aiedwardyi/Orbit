import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const boot = readFileSync(join(here, "packaged-boot.ts"), "utf8");

describe("packaged boot listens before importing the fat harness", () => {
  it("starts early listen, then dynamically imports index", () => {
    const listenAt = boot.indexOf("startEarlyListen(");
    const importAt = boot.indexOf("./index.js");
    expect(listenAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(-1);
    expect(listenAt).toBeLessThan(importAt);
    expect(boot).toContain("import.meta.url");
  });

  it("is bundled as a sibling of index.js without inlining the fat harness", () => {
    const bundle = readFileSync(join(here, "../scripts/bundle-server.mjs"), "utf8");
    expect(bundle).toContain('"packaged-boot.js"');
    expect(bundle).toMatch(/external:\s*\[\s*["']\.\/index\.js["']/);
  });
});
