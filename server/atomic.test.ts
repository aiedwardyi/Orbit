import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renamePlan = vi.hoisted(() => ({ calls: 0, codes: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      renamePlan.calls += 1;
      const code = renamePlan.codes.shift();
      if (code) throw Object.assign(new Error(code), { code });
      return actual.renameSync(...args);
    },
  };
});

// The test setup already loads atomic.ts (via config.ts), so reset the
// module graph to re-import it with the mocked renameSync.
vi.resetModules();
const { writeFileAtomic } = await import("./atomic.ts");

describe("writeFileAtomic", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-atomic-"));
    renamePlan.calls = 0;
    renamePlan.codes = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, '{"a":1}');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}');
  });

  it("replaces existing contents in full", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old-and-longer");
    writeFileAtomic(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
  });

  it("leaves no temp files behind", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "a");
    writeFileAtomic(p, "b");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it("preserves unicode across the write", () => {
    const p = join(dir, "u.json");
    const s = JSON.stringify({ msg: "café — 日本語 — 🚀" });
    writeFileAtomic(p, s);
    expect(readFileSync(p, "utf8")).toBe(s);
    expect(existsSync(p)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("applies the requested mode when replacing a file", () => {
    const p = join(dir, "secret.json");
    writeFileAtomic(p, "old");
    chmodSync(p, 0o644);

    writeFileAtomic(p, "new", { mode: 0o600 });

    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("cleans up the temporary file when replacement fails", () => {
    const p = join(dir, "target");
    mkdirSync(p);
    expect(() => writeFileAtomic(p, "cannot replace a directory")).toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  });

  it.each(["EPERM", "EBUSY"] as const)("retries the rename twice on %s, then succeeds", (code) => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old");
    renamePlan.calls = 0;
    renamePlan.codes = [code, code];
    writeFileAtomic(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["x.json"]);
    expect(renamePlan.calls).toBe(3);
  });

  it("throws EPERM after six renames when the lock never clears", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old");
    renamePlan.calls = 0;
    renamePlan.codes = Array<string>(10).fill("EPERM");
    expect(() => writeFileAtomic(p, "new")).toThrow(expect.objectContaining({ code: "EPERM" }));
    expect(readFileSync(p, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["x.json"]);
    expect(renamePlan.calls).toBe(6);
  });

  it("throws at once on EXDEV", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old");
    renamePlan.calls = 0;
    renamePlan.codes = ["EXDEV"];
    expect(() => writeFileAtomic(p, "new")).toThrow(expect.objectContaining({ code: "EXDEV" }));
    expect(renamePlan.calls).toBe(1);
    expect(readFileSync(p, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it.skipIf(process.platform !== "win32")("throws a retry code while another handle holds the target open", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old");
    // Windows refuses to replace a file any other handle has open, as Defender or the Drive client do.
    const fd = openSync(p, "r");
    try {
      expect(() => writeFileAtomic(p, "new")).toThrow(expect.objectContaining({ code: expect.stringMatching(/^(EPERM|EBUSY)$/) }));
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(p, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });
});
