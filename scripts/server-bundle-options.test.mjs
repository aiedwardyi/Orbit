import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import { serverBundleOptions } from "./server-bundle-options.mjs";

const relay = fileURLToPath(new URL("../server/phone-relay/", import.meta.url));

describe("server bundle", () => {
  it("loads the lazily imported relay client under Node", async () => {
    const out = mkdtempSync(join(tmpdir(), "wink-bundle-"));
    try {
      await build({ ...serverBundleOptions, entryPoints: [join(relay, "index.ts"), join(relay, "ingress.ts")], outdir: out, logLevel: "silent" });
      for (const file of ["index.js", "ingress.js"]) {
        const href = pathToFileURL(join(out, file)).href;
        const run = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(href)});`], { encoding: "utf8" });
        expect(run.status, `${file}: ${run.stderr}`).toBe(0);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
