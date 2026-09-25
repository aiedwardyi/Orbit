import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { memorySyncDir, syncBotMemory, type MemorySyncLedger } from "./memory-sync.ts";
import { isMemoryTopicName, MEMORY_SEED } from "./workspace.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "orbit-memory-sync-"));
  roots.push(root);
  const folder = join(root, "drive");
  mkdirSync(folder);
  const pc = (name: string) => ({ workspace: join(root, name), ledger: {} as MemorySyncLedger });
  return { folder, a: pc("a"), b: pc("b"), remote: memorySyncDir(folder, "bot-1") };
}

function write(dir: string, file: string, text: string) {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

describe("memory sync", () => {
  it("pushes local changes and pulls them on the other PC", () => {
    const { folder, a, b, remote } = setup();
    write(a.workspace, "MEMORY.md", "# Memory\n- prefers pnpm\n");
    write(a.workspace, "memory/deploy.md", "deploy notes\n");
    expect(syncBotMemory(folder, "bot-1", a.workspace, a.ledger)).toEqual({ "MEMORY.md": "pushed", "memory/deploy.md": "pushed" });
    expect(read(remote, "memory/deploy.md")).toBe("deploy notes\n");
    write(b.workspace, "MEMORY.md", MEMORY_SEED);
    expect(syncBotMemory(folder, "bot-1", b.workspace, b.ledger)).toEqual({ "MEMORY.md": "pulled", "memory/deploy.md": "pulled" });
    expect(read(b.workspace, "MEMORY.md")).toBe("# Memory\n- prefers pnpm\n");
    expect(syncBotMemory(folder, "bot-1", b.workspace, b.ledger)).toEqual({ "MEMORY.md": "current", "memory/deploy.md": "current" });
  });

  it("follows a delete only when the other side did not change the file", () => {
    const { folder, a, b, remote } = setup();
    write(a.workspace, "memory/old.md", "stale\n");
    syncBotMemory(folder, "bot-1", a.workspace, a.ledger);
    syncBotMemory(folder, "bot-1", b.workspace, b.ledger);
    rmSync(join(a.workspace, "memory/old.md"));
    expect(syncBotMemory(folder, "bot-1", a.workspace, a.ledger)["memory/old.md"]).toBe("pushed");
    expect(existsSync(join(remote, "memory/old.md"))).toBe(false);
    expect(syncBotMemory(folder, "bot-1", b.workspace, b.ledger)["memory/old.md"]).toBe("pulled");
    expect(existsSync(join(b.workspace, "memory/old.md"))).toBe(false);
  });

  it("keeps both copies when the same file changed on two PCs", () => {
    const { folder, a, b, remote } = setup();
    write(a.workspace, "MEMORY.md", "base\n");
    syncBotMemory(folder, "bot-1", a.workspace, a.ledger);
    syncBotMemory(folder, "bot-1", b.workspace, b.ledger);
    write(a.workspace, "MEMORY.md", "from a\n");
    write(b.workspace, "MEMORY.md", "from b\n");
    syncBotMemory(folder, "bot-1", a.workspace, a.ledger);
    expect(syncBotMemory(folder, "bot-1", b.workspace, b.ledger)["MEMORY.md"]).toBe("conflict");
    expect(read(b.workspace, "MEMORY.md")).toBe("from b\n");
    expect(read(remote, "MEMORY.md")).toBe("from b\n");
    const parked = Object.keys(b.ledger).map((key) => key.slice("bot-1/".length)).find((file) => file.includes(".conflict-"))!;
    expect(isMemoryTopicName(parked.slice("memory/".length))).toBe(true);
    expect(read(b.workspace, parked)).toBe("from a\n");
    syncBotMemory(folder, "bot-1", a.workspace, a.ledger);
    expect(read(a.workspace, "MEMORY.md")).toBe("from b\n");
    expect(read(a.workspace, parked)).toBe("from a\n");
  });

  it("re-seeds a missing Drive folder from local files instead of deleting them", () => {
    const { folder, a, remote } = setup();
    write(a.workspace, "MEMORY.md", "notes\n");
    syncBotMemory(folder, "bot-1", a.workspace, a.ledger);
    rmSync(remote, { recursive: true });
    expect(syncBotMemory(folder, "bot-1", a.workspace, a.ledger)["MEMORY.md"]).toBe("pushed");
    expect(read(a.workspace, "MEMORY.md")).toBe("notes\n");
    expect(read(remote, "MEMORY.md")).toBe("notes\n");
  });
});
