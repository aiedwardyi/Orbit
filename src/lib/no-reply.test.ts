// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TurnPresence } from "@/components/TurnPresence";
import type { Message } from "@/state/store";
import { applyLocale } from "./i18n";
import { NO_REPLY_MS, useNoReply } from "./no-reply";
import { currentTurnId, turnPhase, turnStageLabel, type TurnSignal } from "./turn-stage";

const here = dirname(fileURLToPath(import.meta.url));
const chatView = readFileSync(join(here, "../components/ChatView.tsx"), "utf8");

const user: Message = { id: "u1", at: 1, role: "user", kind: "text", text: "hi" };
const runningTool: Message = { id: "a1", at: 2, role: "bot", kind: "activity", tool: { name: "Bash: pnpm test" } };
const doneTool: Message = { ...runningTool, tool: { name: "Bash: pnpm test", ok: true } };
const preamble: Message = { id: "b1", at: 3, role: "bot", kind: "text", text: "Looking." };

type Stage = { signal?: TurnSignal; lastMessage?: Message; streaming?: string; reasoning?: string; gen?: number; driverKind?: string };
const waiting: Stage = { signal: "started", lastMessage: user, driverKind: "antigravityAgent" };

function Probe({ signal, lastMessage, streaming, reasoning, gen = 0, driverKind }: Stage) {
  const phase = turnPhase({ signal, lastMessage, streaming, reasoning });
  const noReply = useNoReply(phase === "waiting" ? `t1:${currentTurnId({ gen: { t1: gen } }, "t1", lastMessage?.id)}` : null, driverKind);
  return createElement("span", { "data-quiet": String(noReply?.quiet ?? false) }, turnStageLabel(phase, "Running a command", undefined, noReply?.label));
}

let host: HTMLDivElement;
let root: Root;
const render = (stage: Stage) => act(async () => root.render(createElement(Probe, stage)));
const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));
const label = () => host.textContent;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  applyLocale("en");
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  applyLocale("en");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("no reply hint", () => {
  it("waits a full T before naming the engine", async () => {
    await render(waiting);
    await advance(NO_REPLY_MS - 1000);
    expect(label()).toBe("Waiting for the model");
    await advance(1000);
    expect(label()).toBe("Gemini hasn't replied in 2\u00a0min");
  });

  it("counts whole minutes on one minute-aligned timer", async () => {
    await render(waiting);
    expect(vi.getTimerCount()).toBe(1);
    await advance(NO_REPLY_MS);
    await advance(59_999);
    expect(label()).toBe("Gemini hasn't replied in 2\u00a0min");
    expect(vi.getTimerCount()).toBe(1);
    await advance(1);
    expect(label()).toBe("Gemini hasn't replied in 3\u00a0min");
    await advance(60_000);
    expect(label()).toBe("Gemini hasn't replied in 4\u00a0min");
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each<[string, Stage, Stage]>([
    ["a delta", { ...waiting, streaming: "" }, { ...waiting, lastMessage: preamble }],
    ["a reasoning delta", { ...waiting, reasoning: "" }, { ...waiting, lastMessage: preamble }],
    ["a tool start", { ...waiting, lastMessage: runningTool }, { ...waiting, lastMessage: doneTool }],
    ["a retry", { ...waiting, signal: "retrying" }, waiting],
    ["a stop", { ...waiting, signal: undefined }, waiting],
    ["a new tail", { ...waiting, lastMessage: preamble }, { ...waiting, lastMessage: preamble }],
    ["a resend before the tail moves", { ...waiting, gen: 1 }, { ...waiting, gen: 1 }],
  ])("%s restarts the wait", async (_name, interrupt, resume) => {
    await render(waiting);
    await advance(NO_REPLY_MS - 10_000);
    await render(interrupt);
    await render(resume);
    await advance(NO_REPLY_MS - 1000);
    expect(label()).toBe("Waiting for the model");
    await advance(1000);
    expect(label()).toBe("Gemini hasn't replied in 2\u00a0min");
  });

  it("counts a post-tool wait from the tool's end", async () => {
    await render({ ...waiting, lastMessage: runningTool });
    await advance(NO_REPLY_MS + 30_000);
    expect(label()).toBe("Running a command");
    expect(vi.getTimerCount()).toBe(0);
    await render({ ...waiting, lastMessage: doneTool });
    await advance(NO_REPLY_MS - 1000);
    expect(label()).toBe("Waiting for the model");
    await advance(1000);
    expect(label()).toBe("Gemini hasn't replied in 2\u00a0min");
  });

  it("drops the hint and its timer when the wait ends", async () => {
    await render(waiting);
    await advance(NO_REPLY_MS);
    await render({ ...waiting, streaming: "Hi" });
    expect(label()).toBe("Responding");
    expect(vi.getTimerCount()).toBe(0);
    await render(waiting);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(host);
  });

  it.each([
    ["claudeAgent", "Claude"],
    ["codex", "Codex"],
    ["antigravityAgent", "Gemini"],
    ["grokAgent", "Grok"],
    ["museAgent", "Muse"],
    ["cursor", "The model"],
    [undefined, "The model"],
  ])("names %s as %s", async (driverKind, name) => {
    await render({ ...waiting, driverKind });
    await advance(NO_REPLY_MS);
    expect(label()).toBe(`${name} hasn't replied in 2\u00a0min`);
  });

  it("reads in Korean", async () => {
    applyLocale("ko");
    await render(waiting);
    await advance(NO_REPLY_MS);
    await advance(60_000);
    expect(label()).toBe("3분째 Gemini 응답이 없어요");
    await render({ ...waiting, driverKind: undefined });
    expect(label()).toBe("3분째 모델 응답이 없어요");
  });

  it("announces the hint once, then updates quietly", async () => {
    await render(waiting);
    await advance(NO_REPLY_MS);
    expect(host.querySelector("span")?.dataset.quiet).toBe("false");
    await advance(60_000);
    expect(host.querySelector("span")?.dataset.quiet).toBe("true");
    const quiet = renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, label: "Gemini hasn't replied in 3\u00a0min", quiet: true }));
    expect(quiet).toContain('aria-live="off"');
    expect(renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, label: "Waiting" }))).toContain('aria-live="polite"');
  });

  it("names the engine the turn runs on, not a pending pick", () => {
    expect(chatView).toContain("const engine = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);");
    expect(chatView).toMatch(/useNoReply\([^;]*, engine\?\.driverKind\)/);
    expect(chatView).toContain("quiet={noReply?.quiet}");
  });

  it("drops the elapsed timer and wraps instead of truncating while the hint shows", () => {
    expect(chatView).toContain("wrap={Boolean(noReply)}");
    expect(chatView).toContain("since={noReply ? undefined : lastUserMessage?.at}");
    const hint = renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, label: "The model hasn't replied in 12\u00a0min", wrap: true }));
    expect(hint).not.toContain("whitespace-nowrap");
    const stage = renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, label: "Running a command" }));
    expect(stage).toContain("whitespace-nowrap");
  });
});
