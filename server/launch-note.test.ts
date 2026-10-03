import { describe, expect, it, vi } from "vitest";

import { paneNotesForTurn, paneNotesSinceLastUserTurn, prepareModelContext } from "./context-compaction.ts";
import { launchNoteText } from "./launch-note.ts";
import type { Message } from "./store.ts";
import { terminalReadGrant } from "./terminal-grant.ts";

const ACCESS = { url: "http://127.0.0.1:52150", token: "bridge-token" };
const LABEL = "THEME-CYCLE | Sonnet 5.5 | medium";

function bridge(body: Record<string, string>, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

describe("launchNoteText", () => {
  it("reads the spawned pane back from the bridge into a launch row", async () => {
    const fetchImpl = bridge({ sessionId: "0f3c9a1e-full", label: LABEL, cwd: "C:\\repo\\wt" });
    const text = await launchNoteText(ACCESS, "bot-1", "0f3c9a1e-full", fetchImpl);
    expect(text).toBe(`Launched ${LABEL}\nLabel: ${LABEL}\nWorking folder: C:\\repo\\wt\nSession: 0f3c9a1e-full`);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:52150/v1/bots/bot-1/terminal?sessionId=0f3c9a1e-full");
    expect(init?.headers).toEqual({ authorization: `Bearer ${terminalReadGrant(ACCESS.token, "bot-1")}` });
  });

  it("redacts secrets and strips control characters", async () => {
    const secret = `sk-${"a".repeat(32)}`;
    const text = await launchNoteText(ACCESS, "bot-1", "p1", bridge({ sessionId: "p1", label: `w\x1b[31m ${secret}`, cwd: "/tmp" }));
    expect(text).not.toContain(secret);
    expect(text).not.toContain("\x1b");
    expect(text?.split("\n")).toHaveLength(4);
  });

  it("adds nothing for an unknown pane, a missing session id, or no bridge", async () => {
    expect(await launchNoteText(ACCESS, "bot-1", "gone", bridge({ error: "Unknown terminal" }, 404))).toBeNull();
    const unused = bridge({});
    expect(await launchNoteText(ACCESS, "bot-1", "", unused)).toBeNull();
    expect(unused).not.toHaveBeenCalled();
    expect(await launchNoteText(null, "bot-1", "p1", unused)).toBeNull();
  });

  it("never reaches a model as a pane note or in replay", async () => {
    const text = (await launchNoteText(ACCESS, "bot-1", "p1", bridge({ sessionId: "p1", label: LABEL, cwd: "/repo" })))!;
    const launch = (id: string): Message => ({ id, at: 2, role: "bot", kind: "launch", text });
    const path: Message[] = [
      { id: "m1", at: 1, role: "user", kind: "text", text: "Spawn the workers" },
      launch("m2"),
      launch("m3"),
      { id: "m4", at: 3, role: "bot", kind: "text", text: "Three workers running" },
    ];

    expect(paneNotesSinceLastUserTurn(path, new Set())).toEqual([]);
    expect(paneNotesForTurn(path, new Set(), undefined, false)).toEqual({ notes: [], newestId: undefined });
    expect(paneNotesForTurn(path, new Set(), undefined, true).newestId).toBeUndefined();
    const replay = await prepareModelContext({ messages: path, contextWindow: 8_192, taskRecordText: "Goal: run workers" });
    expect(replay.status).toBe("ready");
    if (replay.status !== "ready") return;
    expect(replay.transcript.map((unit) => unit.text)).toEqual(["Spawn the workers", "Three workers running"]);
  });
});
