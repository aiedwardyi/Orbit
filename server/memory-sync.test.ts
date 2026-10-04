import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { markTalked, memorySyncDir, syncBotMemory, type LegacyMemoryLedger, type MemorySyncLedger } from "./memory-sync.ts";
import { MEMORY_SEED } from "./workspace.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// PCs with their own Drive replicas; nothing crosses until deliver()
function pcs(count = 2) {
  const root = mkdtempSync(join(tmpdir(), "orbit-memory-sync-"));
  roots.push(root);
  return Array.from({ length: count }, (_, i) => {
    const folder = join(root, `drive-${i}`);
    mkdirSync(folder);
    const ledger: MemorySyncLedger = { bots: {} };
    const legacy: LegacyMemoryLedger = {};
    return { folder, workspace: join(root, `pc-${i}`), ledger, legacy, host: `host-${i}` };
  });
}

type PC = ReturnType<typeof pcs>[number];

const sync = (pc: PC) => syncBotMemory(pc.folder, "bot-1", pc.workspace, pc.ledger, { legacy: pc.legacy, host: pc.host });
const ownSnapshot = (pc: PC) => join(memorySyncDir(pc.folder, "bot-1"), `${pc.ledger.device}.json`);
const capture = (pc: PC) => readFileSync(ownSnapshot(pc), "utf8");

// Drive hands another PC's snapshot to this one, or replays an old one
function receive(from: PC, to: PC, snapshot = capture(from)) {
  mkdirSync(memorySyncDir(to.folder, "bot-1"), { recursive: true });
  writeFileSync(join(memorySyncDir(to.folder, "bot-1"), `${from.ledger.device}.json`), snapshot);
}

function edit(pc: PC, text: string | null, file = "MEMORY.md", at?: number) {
  const path = join(pc.workspace, file);
  if (text === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  if (at) utimesSync(path, at / 1000, at / 1000);
}

const read = (pc: PC, file = "MEMORY.md") => (existsSync(join(pc.workspace, file)) ? readFileSync(join(pc.workspace, file), "utf8") : null);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// the set-aside copies' text, without the note memory sync puts on top
const parked = (pc: PC) =>
  existsSync(join(pc.workspace, "memory"))
    ? readdirSync(join(pc.workspace, "memory"))
        .filter((name) => name.includes(".conflict-"))
        .map((name) => read(pc, `memory/${name}`)!.replace(/^<!-- memory sync:[^\n]*\n/, ""))
        .sort()
    : [];

// every PC starts from the same notes
function seed(text: string, ...all: PC[]) {
  edit(all[0], text);
  for (const pc of all) sync(pc);
  for (const pc of all.slice(1)) {
    receive(all[0], pc);
    sync(pc);
  }
}

describe("memory sync", () => {
  it("pushes local changes and pulls them on the other PC", () => {
    const [a, b] = pcs();
    edit(a, "# Memory\n- prefers pnpm\n");
    edit(a, "deploy notes\n", "memory/deploy.md");
    expect(sync(a)).toEqual({ "MEMORY.md": "pushed", "memory/deploy.md": "pushed" });
    edit(b, MEMORY_SEED);
    sync(b);
    receive(a, b);
    expect(sync(b)).toEqual({ "MEMORY.md": "pulled", "memory/deploy.md": "pulled" });
    expect(read(b)).toBe("# Memory\n- prefers pnpm\n");
    expect(read(b, "memory/deploy.md")).toBe("deploy notes\n");
    expect(sync(b)).toEqual({ "MEMORY.md": "current", "memory/deploy.md": "current" });
  });

  it("follows a delete made on the other PC", () => {
    const [a, b] = pcs();
    edit(a, "stale\n", "memory/old.md");
    sync(a);
    sync(b);
    receive(a, b);
    expect(sync(b)["memory/old.md"]).toBe("pulled");
    edit(a, null, "memory/old.md");
    expect(sync(a)["memory/old.md"]).toBe("pushed");
    receive(a, b);
    expect(sync(b)["memory/old.md"]).toBe("pulled");
    expect(read(b, "memory/old.md")).toBeNull();
  });

  it("keeps edits to different files from both PCs", () => {
    const [a, b] = pcs();
    seed("base\n", a, b);
    edit(a, "base\nfrom a\n");
    sync(a);
    edit(b, "work notes\n", "memory/work.md");
    sync(b);
    receive(a, b);
    receive(b, a);
    sync(a);
    sync(b);
    for (const pc of [a, b]) {
      expect(read(pc)).toBe("base\nfrom a\n");
      expect(read(pc, "memory/work.md")).toBe("work notes\n");
      expect(parked(pc)).toEqual([]);
    }
  });

  it("keeps the copy from the PC the user last messaged and sets the other aside on both PCs", () => {
    const [a, b] = pcs();
    seed("base\n", a, b);
    edit(a, "from a\n");
    markTalked(a.ledger, "bot-1", 5_000);
    sync(a);
    edit(b, "from b\n");
    markTalked(b.ledger, "bot-1", 9_000);
    sync(b);
    receive(a, b);
    receive(b, a);
    expect(sync(a)["MEMORY.md"]).toBe("conflict");
    expect(sync(b)["MEMORY.md"]).toBe("conflict");
    for (const pc of [a, b]) {
      expect(read(pc)).toBe("from b\n");
      expect(parked(pc)).toEqual(["from a\n"]);
    }
    for (let round = 0; round < 2; round++) {
      receive(a, b);
      receive(b, a);
      expect(sync(a)["MEMORY.md"]).toBe("current");
      expect(sync(b)["MEMORY.md"]).toBe("current");
    }
    expect(parked(a)).toEqual(["from a\n"]);
    expect(parked(b)).toEqual(["from a\n"]);
  });

  it("dates the set-aside copy so the bot can tell how old it is", () => {
    const [a, b] = pcs();
    seed("base\n", a, b);
    edit(a, "from a\n", "MEMORY.md", Date.UTC(2026, 9, 2, 9, 21));
    sync(a);
    edit(b, "from b\n");
    markTalked(b.ledger, "bot-1", 9_000);
    sync(b);
    receive(a, b);
    sync(b);
    const name = readdirSync(join(b.workspace, "memory")).find((file) => file.includes(".conflict-"))!;
    expect(name).toMatch(/^MEMORY\.conflict-[0-9a-f]{8}\.md$/);
    expect(read(b, `memory/${name}`)!.split("\n")[0]).toContain("last edited 2026-10-02 09:21 UTC");
  });

  it("breaks a tie by the later edit when the user messaged neither PC", () => {
    const [a, b] = pcs();
    seed("base\n", a, b);
    edit(a, "from a\n", "MEMORY.md", 3_000_000_000);
    sync(a);
    edit(b, "from b\n", "MEMORY.md", 2_000_000_000);
    sync(b);
    receive(a, b);
    receive(b, a);
    sync(a);
    sync(b);
    for (const pc of [a, b]) {
      expect(read(pc)).toBe("from a\n");
      expect(parked(pc)).toEqual(["from b\n"]);
    }
  });

  it("keeps the other PC's text when a delete wins a tie", () => {
    const [a, b] = pcs();
    seed("deploy Fridays\n", a, b);
    edit(a, null);
    markTalked(a.ledger, "bot-1", 9_000);
    sync(a);
    edit(b, "deploy Fridays\nwork ready\n");
    sync(b);
    receive(a, b);
    expect(sync(b)["MEMORY.md"]).toBe("conflict");
    expect(read(b)).toBeNull();
    expect(parked(b)).toEqual(["deploy Fridays\nwork ready\n"]);
  });

  it("ignores a replayed older copy after a correction", () => {
    const [h, w] = pcs();
    seed("pnpm\n", h, w);
    edit(w, "pnpm\nincorrect deployment\n");
    sync(w);
    const stale = capture(w);
    receive(w, h);
    expect(sync(h)["MEMORY.md"]).toBe("pulled");
    edit(h, "pnpm\n");
    expect(sync(h)["MEMORY.md"]).toBe("pushed");
    receive(w, h, stale);
    expect(sync(h)["MEMORY.md"]).toBe("current");
    expect(read(h)).toBe("pnpm\n");
    expect(parked(h)).toEqual([]);
  });

  it("sets aside an edit to a copy this PC undid, however many edits ago", () => {
    for (const depth of [1, 8, 20]) {
      const [h, w] = pcs();
      seed("pnpm\n", h, w);
      edit(w, "pnpm\nincorrect deployment\n");
      sync(w);
      receive(w, h);
      sync(h);
      for (let i = 1; i < depth; i++) {
        edit(h, `intermediate ${i}\n`);
        sync(h);
      }
      edit(h, "pnpm\n");
      markTalked(h.ledger, "bot-1", 9_000);
      sync(h);
      edit(w, "pnpm\nincorrect deployment\nwork ready\n");
      sync(w);
      receive(w, h);
      expect(sync(h)["MEMORY.md"], `depth ${depth}`).toBe("conflict");
      expect(read(h), `depth ${depth}`).toBe("pnpm\n");
      expect(parked(h), `depth ${depth}`).toEqual(["pnpm\nincorrect deployment\nwork ready\n"]);
    }
  });

  it("ignores snapshots it cannot read or trust", () => {
    const [h, w] = pcs();
    seed("pnpm\n", h, w);
    const device = w.ledger.device!;
    // a snapshot claiming a newer "stale" copy, with `vv` spliced in as raw JSON
    const stale = (vv: string, { file = "MEMORY.md", version = 1, owner = device } = {}) =>
      `{"format":"orbit.memory-sync","version":${version},"device":"${owner}","talkedAt":0,"files":{${JSON.stringify(file)}:{"vv":${vv},"at":1,"text":"stale\\n"}}}`;
    const home = h.ledger.device!;
    // each would win if trusted: it claims every edit home made and more
    const newer = `{"${home}":5,"${device}":99}`;
    const bad = [
      "{ half a file",
      stale(newer, { owner: "ffffffffffff" }),
      stale(newer, { version: 2 }),
      stale(`{"${home}":5,"${device}":-1}`),
      stale(`{"${home}":5,"${device}":1.5}`),
      stale(`{"${home}":5,"${device}":9007199254740992}`),
      stale(`{"${home}":5,"not-a-device":99}`),
      stale("[99]"),
      stale(`"99"`),
      stale("null"),
      stale(newer, { file: "../escape.md" }),
      stale(newer, { file: "memory/../../escape.md" }),
    ];
    for (const snapshot of bad) {
      receive(w, h, snapshot);
      expect(sync(h)["MEMORY.md"], snapshot).toBe("current");
      expect(read(h)).toBe("pnpm\n");
    }
    expect(existsSync(join(h.workspace, "..", "escape.md"))).toBe(false);
    expect(parked(h)).toEqual([]);
    receive(w, h, stale(newer));
    expect(sync(h)["MEMORY.md"]).toBe("pulled");
    expect(read(h)).toBe("stale\n");
  });

  it("gives a ledger copied from another PC its own identity", () => {
    const [h, w] = pcs();
    edit(h, "pnpm\n");
    sync(h);
    w.ledger = structuredClone(h.ledger);
    edit(w, "pnpm\n");
    edit(h, "home correction\n");
    markTalked(h.ledger, "bot-1", 9_000);
    sync(h);
    edit(w, "work divergent\n");
    sync(w);
    edit(w, "work divergent plus\n");
    sync(w);
    expect(w.ledger.device).not.toBe(h.ledger.device);
    receive(w, h);
    expect(sync(h)["MEMORY.md"]).toBe("conflict");
    expect(read(h)).toBe("home correction\n");
    expect(parked(h)).toEqual(["work divergent plus\n"]);
  });

  it("does not reuse its counts after its ledger is rolled back", () => {
    const [h, w] = pcs();
    seed("v1\n", h, w);
    const backup = structuredClone(h.ledger);
    edit(h, "v2\n");
    sync(h);
    receive(h, w);
    sync(w);
    h.ledger = backup;
    edit(h, "v3 after restore\n");
    sync(h);
    receive(h, w);
    expect(sync(w)["MEMORY.md"]).toBe("pulled");
    expect(read(w)).toBe("v3 after restore\n");
    expect(parked(w)).toEqual([]);
  });

  it("treats the same versions with different text as a tie", () => {
    const [h, w] = pcs();
    seed("pnpm\n", h, w);
    const forged = JSON.parse(capture(h));
    forged.files["MEMORY.md"].text = "forged\n";
    receive(h, w, JSON.stringify(forged));
    expect(sync(w)["MEMORY.md"]).toBe("conflict");
    expect([read(w), ...parked(w)].sort()).toEqual(["forged\n", "pnpm\n"]);
  });

  it("relays hundreds of alternating edits to a PC that was away, without a conflict", () => {
    const [h, w, l] = pcs(3);
    seed("v0\n", h, w, l);
    for (let i = 1; i <= 320; i++) {
      const [from, to] = i % 2 ? [w, h] : [h, w];
      edit(from, `v${i}\n`);
      sync(from);
      receive(from, to);
      expect(sync(to)["MEMORY.md"]).toBe("pulled");
    }
    receive(h, l);
    receive(w, l);
    expect(sync(l)["MEMORY.md"]).toBe("pulled");
    expect(read(l)).toBe("v320\n");
    expect(parked(l)).toEqual([]);
  }, 30_000);

  it("pulls a copy two other PCs built on since this one last synced", () => {
    const [a, b, c] = pcs(3);
    seed("v1\n", a, b, c);
    edit(a, "v2\n");
    sync(a);
    receive(a, b);
    sync(b);
    edit(b, "v3\n");
    sync(b);
    receive(b, c);
    sync(c);
    edit(c, "v4\n");
    sync(c);
    receive(c, a);
    expect(sync(a)["MEMORY.md"]).toBe("pulled");
    expect(read(a)).toBe("v4\n");
  });

  it("joins PCs that already hold the same notes without a conflict", () => {
    const [h, w] = pcs();
    edit(h, "same\n");
    edit(w, "same\n");
    sync(h);
    sync(w);
    receive(h, w);
    receive(w, h);
    expect(sync(h)["MEMORY.md"]).toBe("current");
    expect(sync(w)["MEMORY.md"]).toBe("current");
    edit(w, "same\nmore\n");
    sync(w);
    receive(w, h);
    expect(sync(h)["MEMORY.md"]).toBe("pulled");
    expect(parked(h)).toEqual([]);
  });

  it("lets a copy the older build pulled give way on first sync, and sets aside one it pushed", () => {
    const [h, w] = pcs();
    edit(h, "home notes\n");
    edit(h, "home deploy\n", "memory/deploy.md");
    h.legacy = {
      "bot-1/MEMORY.md": sha("home notes\n"),
      "~bot-1/MEMORY.md": sha("older\n"),
      "bot-1/memory/deploy.md": sha("home deploy\n"),
    };
    edit(w, "older\n");
    edit(w, "work deploy\n", "memory/deploy.md");
    w.legacy = {
      "bot-1/MEMORY.md": sha("older\n"),
      "~bot-1/MEMORY.md": sha("older\n"),
      "bot-1/memory/deploy.md": sha("work deploy\n"),
      "~bot-1/memory/deploy.md": sha("home deploy\n"),
    };
    markTalked(h.ledger, "bot-1", 9_000);
    sync(h);
    sync(w);
    receive(h, w);
    receive(w, h);
    expect(sync(w)).toMatchObject({ "MEMORY.md": "pulled", "memory/deploy.md": "conflict" });
    expect(sync(h)).toMatchObject({ "MEMORY.md": "current", "memory/deploy.md": "conflict" });
    for (const pc of [h, w]) {
      expect(read(pc)).toBe("home notes\n");
      expect(read(pc, "memory/deploy.md")).toBe("home deploy\n");
    }
    expect(parked(w)).toEqual(["work deploy\n"]);
    expect(parked(h)).toEqual(["work deploy\n"]);
  });

  it("drops a set-aside copy once its file holds every line of it, on both PCs", () => {
    const [a, b] = pcs();
    seed("base\n", a, b);
    edit(a, "from a\n");
    sync(a);
    edit(b, "from b\n");
    markTalked(b.ledger, "bot-1", 9_000);
    sync(b);
    receive(a, b);
    sync(b);
    receive(b, a);
    sync(a);
    expect(parked(a)).toEqual(["from a\n"]);
    edit(b, "from b\nmore\n");
    sync(b);
    expect(parked(b)).toEqual(["from a\n"]);
    edit(b, "from b\nmore\nfrom a\n");
    sync(b);
    expect(parked(b)).toEqual([]);
    receive(b, a);
    sync(a);
    expect(read(a)).toBe("from b\nmore\nfrom a\n");
    expect(parked(a)).toEqual([]);
  });

  it("drops a set-aside copy right away when it adds nothing to the copy kept", () => {
    const [h, w] = pcs();
    seed("pnpm\n", h, w);
    edit(h, "pnpm\ndeploy Fridays\n");
    sync(h);
    edit(w, "pnpm\ndeploy Fridays\nwork ready\n");
    markTalked(w.ledger, "bot-1", 9_000);
    sync(w);
    receive(h, w);
    expect(sync(w)["MEMORY.md"]).toBe("conflict");
    expect(read(w)).toBe("pnpm\ndeploy Fridays\nwork ready\n");
    expect(parked(w)).toEqual([]);
  });

  it("re-seeds Drive from local files when the folder is gone", () => {
    const [a] = pcs(1);
    edit(a, "notes\n");
    sync(a);
    rmSync(memorySyncDir(a.folder, "bot-1"), { recursive: true });
    sync(a);
    expect(read(a)).toBe("notes\n");
    expect(JSON.parse(capture(a)).files["MEMORY.md"].text).toBe("notes\n");
  });

  it("pulls into a missing workspace instead of deleting the notes everywhere", () => {
    const [a, b] = pcs();
    seed("notes\n", a, b);
    rmSync(b.workspace, { recursive: true });
    expect(sync(b)["MEMORY.md"]).toBe("pulled");
    expect(read(b)).toBe("notes\n");
    receive(b, a);
    expect(sync(a)["MEMORY.md"]).toBe("current");
    expect(read(a)).toBe("notes\n");
  });

  it("publishes the last good copy of a file it cannot read this pass", () => {
    const [a] = pcs(1);
    edit(a, "deploy notes\n", "memory/deploy.md");
    sync(a);
    const before = JSON.parse(capture(a)).files["memory/deploy.md"];
    rmSync(join(a.workspace, "memory/deploy.md"));
    mkdirSync(join(a.workspace, "memory/deploy.md"));
    expect(sync(a)["memory/deploy.md"]).toBe("skipped");
    expect(JSON.parse(capture(a)).files["memory/deploy.md"]).toEqual(before);
  });
});
