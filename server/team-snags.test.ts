import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PHONE_RELAY_OFF, SNAG_MAX_BYTES, teamSnagSchema, type PhoneRelayStatus, type TeamSnag } from "../shared/relay-protocol.ts";
import { buildTeamSnag, scrubSnagText, SNAG_SPOOL_DIR, TeamSnags, type SpooledSnag } from "./team-snags.ts";
import { PhoneAccess } from "./phone-access.ts";

const ctx = { home: "C:\\Users\\Jisoo", user: "jisoo" };
const MIN = 60_000;

describe("scrubSnagText", () => {
  it("replaces the home dir in both slash styles and any case", () => {
    expect(scrubSnagText("open C:\\Users\\Jisoo\\work\\a.csv and c:/users/JISOO/work/b.csv", ctx)).toBe("open ~\\work\\a.csv and ~/work/b.csv");
    expect(scrubSnagText("cd /home/jisoo/src", { home: "/home/jisoo", user: "jisoo" })).toBe("cd ~/src");
  });

  it("replaces the OS username outside the home dir", () => {
    expect(scrubSnagText("fixtures/jisoo-march.csv by Jisoo", ctx)).toBe("fixtures/«user»-march.csv by «user»");
    expect(scrubSnagText("jisoohan stays", ctx)).toBe("jisoohan stays");
  });

  it("replaces emails", () => {
    expect(scrubSnagText("mail kim.lee+x@studio.co.kr now", ctx)).toBe("mail «email» now");
  });

  it("keeps only the scheme and host of URLs", () => {
    expect(scrubSnagText("GET https://user:pw@chatgpt.com/backend/x?q=1 failed", ctx)).toBe("GET https://chatgpt.com/… failed");
    expect(scrubSnagText("at http://127.0.0.1:4000", ctx)).toBe("at http://127.0.0.1:4000");
  });

  it("masks long hex and base64 runs", () => {
    const hex = "9f2c41d07a5e4b6c8d1e3f2a0b9c7d6e9f2c41d0";
    const b64 = "QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYzT4bW5vcHFyc3R1";
    expect(scrubSnagText(`commit ${hex} token ${b64}`, ctx)).toBe(`commit «redacted 40 chars» token «redacted ${b64.length} chars»`);
    expect(scrubSnagText("node_modules/some-package/dist/index", ctx)).toBe("node_modules/some-package/dist/index");
  });

  it("masks a known key shape through redactSecretsInText", () => {
    const out = scrubSnagText("ANTHROPIC key sk-ant-api03-abcdefghijabcdefghijabcdefghij leaked", ctx);
    expect(out).not.toContain("sk-ant-api03-abcdefghij");
    expect(out).toContain("«redacted");
  });

  it("strips ANSI and control characters", () => {
    expect(scrubSnagText("\x1b[31mFAIL\x1b[0m\r\nnext\x07", ctx)).toBe("FAIL\nnext");
  });
});

describe("buildTeamSnag", () => {
  const raw: SpooledSnag = { id: "9f2c41d07a5e4b6c8d1e3f2a0b9c7d6e", at: 1_793_425_560_000, event: "stalled", key: "pane-1", pane: "3fa91c02-aaaa", worker: "codex", label: "INVOICE-EXPORT", minutes: 102 };
  const meta = { ...ctx, build: "1.0.217", os: "win32", teacher: "claude:claude-opus-5-5" };

  it("keeps the last 30 lines and fits the frame cap", () => {
    const tail = Array.from({ length: 80 }, (_, i) => `작업 줄 ${i} ${"가".repeat(60)}`).join("\n");
    const snag = buildTeamSnag({ ...raw, tail }, meta);
    expect(teamSnagSchema.safeParse(snag).success).toBe(true);
    expect(snag.tail.split("\n").length).toBeLessThanOrEqual(30);
    expect(snag.tail.endsWith(`작업 줄 79 ${"가".repeat(60)}`)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ type: "snag", data: snag }))).toBeLessThanOrEqual(SNAG_MAX_BYTES);
    expect(snag.pane8).toBe("3fa91c02");
  });
});

describe("TeamSnags", () => {
  let userData: string;
  let now: number;
  let status: PhoneRelayStatus;
  let consent: boolean;
  let sent: TeamSnag[];
  let accept: boolean;
  const spool = () => join(userData, SNAG_SPOOL_DIR);
  const make = (enabled?: () => boolean) => new TeamSnags({
    userData,
    enabled,
    status: () => status,
    send: async (snag) => {
      if (!accept) return false;
      sent.push(snag);
      return true;
    },
    consent: () => consent,
    teacher: (bot) => (bot ? `claude:${bot}` : ""),
    build: "1.0.217",
    os: "win32",
    scrub: ctx,
    now: () => now,
  });
  const queue = (snag: Partial<SpooledSnag> & { key: string }) => {
    mkdirSync(spool(), { recursive: true });
    const full = { id: Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32), at: now, event: "stalled", ...snag };
    writeFileSync(join(spool(), `${full.at}-${full.id}.json`), JSON.stringify(full));
  };

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), "omb-team-snags-"));
    now = Date.UTC(2026, 9, 31, 5, 0);
    status = { ...PHONE_RELAY_OFF, state: "connected", snags: true };
    consent = true;
    sent = [];
    accept = true;
  });
  afterEach(() => rmSync(userData, { recursive: true, force: true }));

  it("opens the queue and sends scrubbed reports oldest first", async () => {
    const snags = make();
    await snags.sync();
    expect(existsSync(spool())).toBe(true);
    queue({ key: "b", at: now - 2 * MIN, event: "note-lost", bot: "bot-1", tail: "C:\\Users\\Jisoo\\x" });
    queue({ key: "a", at: now - 5 * MIN });
    await snags.sync();
    expect(sent.map((s) => s.event)).toEqual(["stalled", "note-lost"]);
    expect(sent[1].teacher).toBe("claude:bot-1");
    expect(sent[1].tail).toBe("~\\x");
    expect(readdirSync(spool())).toEqual([]);
  });

  it("switch off deletes the queue and sends nothing", async () => {
    queue({ key: "a" });
    consent = false;
    await make().sync();
    expect(existsSync(spool())).toBe(false);
    expect(sent).toEqual([]);
    make().record({ event: "wake-failed", key: "bot-1" });
    expect(existsSync(spool())).toBe(false);
  });

  it("switch off mid-send stops and deletes the rest of the queue", async () => {
    queue({ key: "a", at: now - 2 * MIN });
    queue({ key: "b", at: now - MIN });
    const snags = new TeamSnags({ ...make()["options"], send: async (snag) => {
      sent.push(snag);
      consent = false;
      return true;
    } });
    await snags.sync();
    expect(sent).toHaveLength(1);
    expect(existsSync(spool())).toBe(false);
  });

  it("Phone Access off or a relay without snags deletes the queue", async () => {
    queue({ key: "a" });
    status = { ...PHONE_RELAY_OFF };
    await make().sync();
    expect(existsSync(spool())).toBe(false);
    queue({ key: "a" });
    status = { ...PHONE_RELAY_OFF, state: "connected" };
    await make().sync();
    expect(existsSync(spool())).toBe(false);
    expect(sent).toEqual([]);
  });

  it("keeps the queue while reconnecting", async () => {
    queue({ key: "a" });
    status = { ...PHONE_RELAY_OFF, state: "reconnecting" };
    await make().sync();
    expect(readdirSync(spool())).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("preserves the queue through enabled relay initialization and deletes it when disabled", async () => {
    queue({ key: "a" });
    let enabled = true;
    const access = new PhoneAccess({
      dataDir: userData, env: {}, staticDir: null,
      config: () => ({ base: "wink.example", enabled }), saveEnabled: () => {},
      loadClient: async () => { throw new Error("offline"); },
      onChange: () => { status = access.status(); void snags.sync(); },
    });
    const snags = make(() => access.relayEnabled());
    await access.start(() => {});
    expect(readdirSync(spool())).toHaveLength(1);
    expect(sent).toEqual([]);
    enabled = false;
    await access.restart();
    expect(existsSync(spool())).toBe(false);
  });

  it("clamps long server errors before validating the spool", async () => {
    const snags = make();
    await snags.sync();
    snags.record({ event: "wake-failed", key: "bot", detail: "provider error ".repeat(1000) });
    await snags.sync();
    expect(sent).toHaveLength(1);
    expect(sent[0].detail).toBe("provider error ".repeat(1000).slice(0, 300));
  });

  it("deduplicates an old backlog across sender restarts", async () => {
    queue({ key: "bot", event: "wake-failed", at: now - 180 * MIN });
    await make().sync();
    queue({ key: "bot", event: "wake-failed", at: now - 179 * MIN });
    queue({ key: "other", event: "wake-failed", at: now - 178 * MIN });
    await make().sync();
    expect(sent.map((s) => s.at)).toEqual([now - 180 * MIN, now - 178 * MIN]);
    expect(readdirSync(spool())).toEqual([]);
  });

  it("keeps a report the relay did not take", async () => {
    queue({ key: "a" });
    accept = false;
    await make().sync();
    expect(readdirSync(spool())).toHaveLength(1);
    accept = true;
    await make().sync();
    expect(sent).toHaveLength(1);
  });

  it("records server events only while the queue is open", async () => {
    const snags = make();
    snags.record({ event: "wake-failed", key: "bot-1", bot: "bot-1", detail: "spawn EPERM" });
    expect(existsSync(spool())).toBe(false);
    await snags.sync();
    snags.record({ event: "wake-failed", key: "bot-1", bot: "bot-1", detail: "spawn EPERM" });
    await snags.sync();
    expect(sent.map((s) => [s.event, s.detail])).toEqual([["wake-failed", "spawn EPERM"]]);
  });

  it("sends one report per event and key per hour", async () => {
    queue({ key: "a", at: now - 30 * MIN, event: "wake-failed" });
    queue({ key: "a", at: now - 10 * MIN, event: "wake-failed" });
    queue({ key: "b", at: now - 5 * MIN, event: "wake-failed" });
    queue({ key: "a", at: now - 4 * MIN, event: "note-lost" });
    await make().sync();
    expect(sent.map((s) => [s.event, s.at])).toEqual([["wake-failed", now - 30 * MIN], ["wake-failed", now - 5 * MIN], ["note-lost", now - 4 * MIN]]);
    now += 61 * MIN;
    queue({ key: "a", event: "wake-failed" });
    await make().sync();
    expect(sent).toHaveLength(4);
  });

  it("caps sends at 10 per UTC day", async () => {
    for (let i = 0; i < 12; i++) queue({ key: `k${i}`, at: now - (12 - i) * MIN });
    await make().sync();
    expect(sent).toHaveLength(10);
    expect(readdirSync(spool())).toHaveLength(2);
    now = Date.UTC(2026, 10, 1, 0, 1);
    await make().sync();
    expect(sent).toHaveLength(12);
  });

  it("keeps the newest 20 and expires reports after 3 days", async () => {
    accept = false;
    queue({ key: "old", at: now - 3 * 24 * 60 * MIN - MIN });
    for (let i = 0; i < 22; i++) queue({ key: `k${i}`, at: now - (22 - i) * MIN });
    await make().sync();
    accept = true;
    await make().sync();
    expect(sent).toHaveLength(10);
    expect(sent[0].at).toBe(now - 20 * MIN);
  });
});

describe("pane wake failure", () => {
  it("reports a non-busy failure and not a busy one", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const body = source.match(/startTurn\(botId, PANE_WAKE_PROMPT[^\n]*\.catch\(\(err\) => \{\n([\s\S]+?)\n    \}\);/)![1];
    const javascript = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const run = new Function("err", "botId", "isBusyRejection", "paneWake", "console", "teamSnags", "threadId", javascript);
    const record = vi.fn();
    const noteArrived = vi.fn();
    const busy = new Error("busy");
    run(busy, "bot-1", (err: Error) => err === busy, { noteArrived }, { warn: () => {} }, { record });
    expect(record).not.toHaveBeenCalled();
    run(new Error("spawn EPERM"), "bot-1", (err: Error) => err === busy, { noteArrived }, { warn: () => {} }, { record });
    expect(record).toHaveBeenCalledExactlyOnceWith({ event: "wake-failed", key: "bot-1", bot: "bot-1", detail: "spawn EPERM" });
  });
});
