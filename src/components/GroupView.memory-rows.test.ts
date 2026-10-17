// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Group, type Message } from "@/state/store";

import { setFindCurrent } from "@/lib/chat-find";
import { applyLocale } from "@/lib/i18n";
import { Transcript } from "./GroupView";

const from = (botId: string) => ({ botId, name: botId, color: "blue" as const });
const say = (id: string, botId: string, at: number): Message => ({ id, at, role: "bot", kind: "text", text: `${id} says hi`, from: from(botId) });
const save = (id: string, botId: string, spoken: string, at: number): Message => ({ id, at, role: "bot", kind: "activity", tool: { name: "memory.save", spoken, ok: true }, from: from(botId) });

const saves = [save("s1", "ada", "likes short replies", 3), save("s2", "ada", "lives in Seoul", 4), save("s3", "ada", "prefers dark mode", 5)];

describe("GroupView memory rows", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    setFindCurrent(null);
    applyLocale("en");
    vi.unstubAllGlobals();
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  const render = (messages: Message[]) => {
    const group: Group = {
      id: "room-1", threadId: "t1", name: "Room", memberIds: [], defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1, messages: [],
    };
    return act(async () =>
      root!.render(
        createElement(StoreProvider, null, createElement(Transcript, {
          group,
          members: [],
          messages,
          transcript: messages,
          streamingMessage: null,
          dock: null,
          onReply: () => undefined,
          onFocusComposer: () => undefined,
          onMessageMenu: () => undefined,
          workers: [],
        })),
      ),
    );
  };
  const mount = async (messages: Message[]) => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render(messages);
  };
  const folds = () => [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].filter((button) => /^(Memory updated ·|메모리 업데이트 ·)/.test(button.textContent ?? ""));
  const labels = () => folds().map((button) => button.textContent);
  const fold = () => folds()[0]!;
  const notes = () => [...host.querySelectorAll("[data-mid]")].filter((row) => row.textContent?.startsWith("Memory updated:")).map((row) => row.textContent);

  it("folds a run of saves into one row that names the count", async () => {
    await mount([say("m1", "ada", 1), ...saves, say("m2", "ada", 9)]);
    expect(labels()).toEqual(["Memory updated · 3 notes"]);
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("likes short replies");
  });

  it("says the count in Korean", async () => {
    applyLocale("ko");
    await mount([say("m1", "ada", 1), ...saves]);
    expect(labels()).toEqual(["메모리 업데이트 · 3개"]);
    expect(host.textContent).not.toContain("Memory updated");
  });

  it("leaves a lone save as today's row", async () => {
    await mount([say("m1", "ada", 1), saves[0]]);
    expect(folds()).toEqual([]);
    expect(host.textContent).toContain("Memory updated: likes short replies");
  });

  it("opens on a click, lists every note oldest first, and folds on the next click", async () => {
    await mount([say("m1", "ada", 1), ...saves]);
    await act(async () => fold().click());
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    expect(notes()).toEqual(["Memory updated: likes short replies", "Memory updated: lives in Seoul", "Memory updated: prefers dark mode"]);
    await act(async () => fold().click());
    expect(notes()).toEqual([]);
  });

  it("is a focusable native button, so Enter and Space open it", async () => {
    await mount([say("m1", "ada", 1), ...saves]);
    expect(fold().tagName).toBe("BUTTON");
    expect(fold().getAttribute("type")).toBe("button");
    expect(fold().disabled).toBe(false);
    expect(fold().tabIndex).toBe(0);
  });

  it("stays open and counts the new note while a bot keeps saving", async () => {
    await mount([say("m1", "ada", 1), ...saves]);
    await act(async () => fold().click());
    await render([say("m1", "ada", 1), ...saves, save("s4", "ada", "owns a cat", 6)]);
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    expect(labels()).toEqual(["Memory updated · 4 notes"]);
    expect(notes()).toHaveLength(4);
  });

  it("keeps another bot's saves in their own run", async () => {
    await mount([say("m1", "ada", 1), saves[0], saves[1], save("s7", "bo", "a", 6), save("s8", "bo", "b", 7)]);
    expect(labels()).toEqual(["Memory updated · 2 notes", "Memory updated · 2 notes"]);
  });

  it("opens for a find hit on a note inside it", async () => {
    await mount([say("m1", "ada", 1), ...saves]);
    expect(notes()).toEqual([]);
    await act(async () => setFindCurrent({ messageId: "s2", query: "Seoul" }));
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[data-mid="s2"]')?.textContent).toBe("Memory updated: lives in Seoul");
  });
});
