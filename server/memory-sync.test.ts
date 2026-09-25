import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// two PCs with their own Drive replicas; nothing crosses until deliver()
function replicas() {
  const root = mkdtempSync(join(tmpdir(), "orbit-memory-sync-"));
  roots.push(root);
  const pc = (name: string) => {
    const folder = join(root, `drive-${name}`);
    mkdirSync(folder);
    return { folder, workspace: join(root, name), ledger: {} as MemorySyncLedger, remote: memorySyncDir(folder, "bot-1") };
  };
  return { a: pc("a"), b: pc("b") };
}

type Replica = ReturnType<typeof replicas>["a"];

const sync = (pc: Replica) => syncBotMemory(pc.folder, "bot-1", pc.workspace, pc.ledger);

function deliver(from: Replica, to: Replica, file: string, sidecar = true) {
  for (const path of sidecar ? [file, `.ancestry/${file}.json`] : [file]) {
    if (!existsSync(join(from.remote, path))) rmSync(join(to.remote, path), { force: true });
    else cpSync(join(from.remote, path), join(to.remote, path));
  }
}

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

  it("keeps both edits when Drive delivers the other PC's copy late", () => {
    const { a, b } = replicas();
    write(a.workspace, "MEMORY.md", "base\n");
    sync(a);
    deliver(a, b, "MEMORY.md");
    sync(b);
    write(a.workspace, "MEMORY.md", "from a\n");
    write(b.workspace, "MEMORY.md", "from b\n");
    expect(sync(a)["MEMORY.md"]).toBe("pushed");
    expect(sync(b)["MEMORY.md"]).toBe("pushed");
    deliver(a, b, "MEMORY.md");
    expect(sync(b)["MEMORY.md"]).toBe("conflict");
    expect(read(b.workspace, "MEMORY.md")).toBe("from b\n");
    const parked = Object.keys(b.ledger).map((key) => key.slice("bot-1/".length)).find((file) => file.includes(".conflict-"))!;
    expect(read(b.workspace, parked)).toBe("from a\n");
    deliver(b, a, "MEMORY.md");
    deliver(b, a, parked);
    expect(sync(a)).toEqual({ "MEMORY.md": "pulled", [parked]: "pulled" });
    expect(read(a.workspace, "MEMORY.md")).toBe("from b\n");
    expect(read(a.workspace, parked)).toBe("from a\n");
  });

  it("does not trust a late copy whose ancestry has not arrived", () => {
    const { a, b } = replicas();
    write(a.workspace, "MEMORY.md", "base\n");
    sync(a);
    deliver(a, b, "MEMORY.md");
    sync(b);
    write(b.workspace, "MEMORY.md", "from b\n");
    sync(b);
    write(a.workspace, "MEMORY.md", "from a\n");
    sync(a);
    deliver(a, b, "MEMORY.md", false);
    expect(sync(b)["MEMORY.md"]).toBe("conflict");
    expect(read(b.workspace, "MEMORY.md")).toBe("from b\n");
  });

  it("follows one-sided edits and deletes across separate replicas", () => {
    const { a, b } = replicas();
    write(a.workspace, "memory/deploy.md", "v1\n");
    sync(a);
    write(a.workspace, "memory/deploy.md", "v2\n");
    sync(a);
    deliver(a, b, "memory/deploy.md");
    expect(sync(b)["memory/deploy.md"]).toBe("pulled");
    write(b.workspace, "memory/deploy.md", "v3\n");
    expect(sync(b)["memory/deploy.md"]).toBe("pushed");
    deliver(b, a, "memory/deploy.md");
    expect(sync(a)["memory/deploy.md"]).toBe("pulled");
    expect(read(a.workspace, "memory/deploy.md")).toBe("v3\n");
    rmSync(join(a.workspace, "memory/deploy.md"));
    expect(sync(a)["memory/deploy.md"]).toBe("pushed");
    deliver(a, b, "memory/deploy.md");
    expect(sync(b)["memory/deploy.md"]).toBe("pulled");
    expect(existsSync(join(b.workspace, "memory/deploy.md"))).toBe(false);
  });

  it("pulls over a pre-ancestry ledger only when the new copy builds on it", () => {
    const { a, b } = replicas();
    for (const pc of [a, b]) {
      write(pc.workspace, "MEMORY.md", "base\n");
      write(pc.remote, "MEMORY.md", "base\n");
      pc.ledger["bot-1/MEMORY.md"] = sha("base\n");
    }
    write(a.workspace, "MEMORY.md", "from a\n");
    sync(a);
    deliver(a, b, "MEMORY.md");
    expect(sync(b)["MEMORY.md"]).toBe("pulled");
    write(b.workspace, "MEMORY.md", "from b\n");
    write(b.remote, "MEMORY.md", "from an old build\n");
    b.ledger = { "bot-1/MEMORY.md": sha("from b\n") };
    expect(sync(b)["MEMORY.md"]).toBe("conflict");
    expect(read(b.workspace, "MEMORY.md")).toBe("from b\n");
  });
});
