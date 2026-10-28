// @vitest-environment happy-dom
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { LiveFrame } from "@/lib/live-events";
import { StoreProvider, type Bot, type InstanceInfo, type Message } from "@/state/store";

import { ChatView } from "./ChatView";
import { CodexDriver } from "../../server/drivers/codex.ts";
import { recordEvents } from "../../server/testing/events.ts";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

type Frame = LiveFrame & { instances?: InstanceInfo[]; threadId?: string; message?: Message };
type Event = { type: string; streamKind?: string; delta?: string; itemType?: string; tokens?: number; input?: number; output?: number };

const MINUTE = 60_000;
const user: Message = { id: "u1", at: 1, role: "user", kind: "text", text: "Think hard" };
const runningTool: Message = { id: "a1", at: 2, role: "bot", kind: "activity", tool: { name: "Bash: pnpm test" } };
const preamble: Message = { id: "b1", at: 3, role: "bot", kind: "text", text: "Checking." };
const bot = (messages: Message[]): Bot => ({
  id: "b1", threadId: "t1", name: "Teacher", title: "", description: "", notifications: false,
  color: "blue", unread: false, busy: true, activity: "working", modelSelection: { instanceId: "inst", model: "m" }, messages,
});

let unmount: (() => Promise<void>) | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const frame = (data: Frame) => act(async () => FakeEventSource.last?.onmessage?.({ data: JSON.stringify(data), lastEventId: "" }));
const runtime = (event: Event) => frame({ kind: "runtime", event: { threadId: "t1", turnId: "turn-1", createdAt: new Date().toISOString(), ...event } });
const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));
const hint = () => /hasn't replied in \d+ min/.exec(host.textContent ?? "")?.[0];

async function mount(driverKind: string, messages: Message[] = [user]) {
  const current = bot(messages);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bots?messages=200"
    ? Response.json({ bots: [current], groups: [], computerControl: {} })
    : new Response("{}", { status: 404 })));
  host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  const render = (next: Bot) => act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(ChatView, { bot: next })))));
  await render(current);
  await frame({ kind: "hello", resumed: false, cursor: "s:0" });
  await frame({ kind: "instances", instances: [{
    instanceId: "inst", driverKind, displayName: "Engine", snapshot: { state: "available" },
    models: { default: "m", options: [{ id: "m", label: "Model" }] },
  }] });
  await runtime({ type: "turn.started" });
  return render;
}

describe("ChatView no reply hint", () => {
  it("shows Thinking through 3 min of silent Codex reasoning, then its reply", async () => {
    vi.useRealTimers();
    const scratch = mkdtempSync(join(tmpdir(), "omb-codex-thinking-"));
    const fixture = join(scratch, "reasoning.json");
    writeFileSync(fixture, JSON.stringify([{
      method: "item/started",
      params: {
        threadId: "codex-thread-1", turnId: "native-turn-1",
        item: { id: "r1", type: "reasoning", summary: [], content: [] },
      },
    }]));
    const instance = await CodexDriver.create({
      instanceId: "inst", displayName: "Codex", enabled: true,
      config: { cli: join(dirname(fileURLToPath(import.meta.url)), "../../server/testing/fake-codex-app-server.ts"), fullAuto: false },
      environment: { FAKE_CODEX_TOOL_FIXTURE: fixture, CODEX_HOME: scratch },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t1", text: "Think hard" });
      await recorder.until((e) => e.type === "turn.completed");
    } finally {
      recorder.stop();
      await instance.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
    vi.useFakeTimers();
    const render = await mount("codex");
    const replyAt = recorder.events.findIndex((e) => e.type === "content.delta" && e.streamKind === "assistant_text");
    expect(replyAt).toBeGreaterThan(-1);
    for (const event of recorder.events.slice(0, replyAt)) {
      await frame({ kind: "runtime", event: { ...event, turnId: "turn-1" } });
    }
    await advance(2 * MINUTE);
    expect(hint()).toBeUndefined();
    expect(host.textContent).toContain("Thinking");
    await advance(MINUTE);
    expect(hint()).toBeUndefined();
    expect(host.textContent).toContain("Thinking");
    const reply: Message = { id: "b2", at: 4, role: "bot", kind: "text", text: "done from fake codex" };
    for (const event of recorder.events.slice(replyAt)) {
      await frame({ kind: "runtime", event: { ...event, turnId: "turn-1" } });
    }
    await frame({ kind: "message", threadId: "t1", message: reply });
    await render({ ...bot([user, reply]), busy: false });
    expect(host.textContent).toContain(reply.text);
    expect(host.textContent).not.toContain("Thinking");
    expect(hint()).toBeUndefined();
  });

  it("never names a Claude turn that keeps reporting thinking tokens", async () => {
    await mount("claudeAgent");
    for (let t = 0; t < 3 * MINUTE; t += 1200) {
      await runtime({ type: "item.updated", itemType: "reasoning", tokens: t / 10 });
      await advance(1200);
    }
    expect(hint()).toBeUndefined();
  });

  it("reads a redacted thinking block as Thinking", async () => {
    await mount("claudeAgent");
    await runtime({ type: "content.delta", streamKind: "reasoning_text", delta: "" });
    await advance(3 * MINUTE);
    expect(host.textContent).toContain("Thinking");
    expect(hint()).toBeUndefined();
  });

  it("waits a full 2 min after a redacted thinking block ends", async () => {
    const render = await mount("claudeAgent");
    await runtime({ type: "content.delta", streamKind: "reasoning_text", delta: "" });
    await advance(3 * MINUTE);
    await frame({ kind: "message", threadId: "t1", message: preamble });
    await render(bot([user, preamble]));
    expect(host.textContent).toContain("Waiting for the model");
    await advance(2 * MINUTE - 1000);
    expect(hint()).toBeUndefined();
    await advance(1000);
    expect(host.textContent).toContain("Claude hasn't replied in 2 min");
  });

  it("never names a turn running one tool for 3 min", async () => {
    await mount("claudeAgent", [user, runningTool]);
    await advance(3 * MINUTE);
    expect(hint()).toBeUndefined();
  });

  it("names a silent Gemini turn at 2 min and counts each minute", async () => {
    await mount("antigravityAgent");
    await advance(2 * MINUTE - 1000);
    expect(hint()).toBeUndefined();
    await advance(1000);
    expect(host.textContent).toContain("Gemini hasn't replied in 2 min");
    await advance(MINUTE);
    expect(host.textContent).toContain("Gemini hasn't replied in 3 min");
  });

  it("drops the hint on any engine event and waits a full 2 min again", async () => {
    await mount("codex");
    await advance(2 * MINUTE);
    expect(hint()).toBe("hasn't replied in 2 min");
    await runtime({ type: "thread.token-usage.updated", input: 1, output: 1 });
    expect(hint()).toBeUndefined();
    await advance(2 * MINUTE - 1000);
    expect(hint()).toBeUndefined();
    await advance(1000);
    expect(host.textContent).toContain("Codex hasn't replied in 2 min");
  });
});
