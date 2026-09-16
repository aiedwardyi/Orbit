import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const boot = readFileSync(join(here, "packaged-boot.ts"), "utf8");
const index = readFileSync(join(here, "index.ts"), "utf8");

describe("packaged boot listens before importing the fat harness", () => {
  it("starts early listen, posts api-token, then dynamically imports index", () => {
    const listenAt = boot.indexOf("startEarlyListen(");
    const postAt = boot.indexOf("postAppToken(issuePackagedCommsToken())");
    const importAt = boot.indexOf('await import(new URL("./index.js"');
    expect(listenAt).toBeGreaterThan(-1);
    expect(postAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(-1);
    expect(listenAt).toBeLessThan(postAt);
    expect(postAt).toBeLessThan(importAt);
    expect(boot).toContain("import.meta.url");
    expect(boot).toContain("OMB_COMMS_TOKEN");
    expect(boot).toContain('"orbit:api-token"');
    expect(boot).toMatch(/randomBytes\(24\)/);
  });

  it("is bundled as a sibling of index.js without inlining the fat harness", () => {
    const bundle = readFileSync(join(here, "../scripts/bundle-server.mjs"), "utf8");
    expect(bundle).toContain('"packaged-boot.js"');
    expect(bundle).toMatch(/external:\s*\[\s*["']\.\/index\.js["']/);
  });

  it("reuses a pre-issued OMB_COMMS_TOKEN in index instead of minting a second secret", () => {
    expect(index).toContain("preissuedCommsToken");
    expect(index).toMatch(/COMMS_TOKEN_RE\s*=\s*\/\^\[a-f0-9\]\{48\}\$/);
    expect(index).toMatch(/preissuedCommsToken[\s\S]*\? preissuedCommsToken[\s\S]*: randomBytes\(24\)/);
  });
});
