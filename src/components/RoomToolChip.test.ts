// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Action, Bot, InstanceInfo, Message } from "@/state/store";

const dispatched: Action[] = [];
let mockState = {
  bots: [] as Bot[],
  instances: [] as InstanceInfo[],
};

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: mockState,
      dispatch: (action: Action) => { dispatched.push(action); },
    }),
  };
});

import { I18nProvider, applyLocale } from "@/lib/i18n";

import { RoomToolChip } from "./GroupView";

describe("RoomToolChip", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    host?.remove();
    localStorage.clear();
    applyLocale("en");
    dispatched.length = 0;
  });

  const comm = { groupId: "pair", withBotId: "b2", withName: "Atlas", withColor: "pink" as const };
  const sent: Message = { id: "sent", at: 1, role: "bot", kind: "activity", tool: { name: "Message to @Atlas" }, comm: { ...comm, peer: "message" }, text: "Check the release.", from: { botId: "b1", name: "Alice", color: "blue" } };
  const reply: Message = { ...sent, id: "reply", tool: { name: "Reply from @Atlas" }, comm: { ...comm, peer: "reply" }, text: "Release is green." };
  async function renderRows(messages: Message[]) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(I18nProvider, null, ...messages.map((message) => createElement(RoomToolChip, { key: message.id, message }))));
    });
    return Array.from(host.querySelectorAll<HTMLButtonElement>("button[title]"));
  }

  it("shows the sent message and the reply under chips that open the pair room, and an older chip as today", async () => {
    const chips = await renderRows([{ id: "old", at: 1, role: "bot", kind: "activity", tool: { name: "@Atlas replied" }, comm }, sent, reply]);
    expect(host.firstElementChild?.className).toBe("flex justify-start");
    expect(chips.map((chip) => chip.querySelector("span.truncate")?.textContent)).toEqual(["@Atlas replied", "Message to @Atlas", "Reply from @Atlas"]);
    expect(Array.from(host.querySelectorAll("[data-peer-body]")).map((body) => body.textContent)).toEqual(["Check the release.", "Release is green."]);
    for (const chip of chips) {
      await act(async () => { chip.click(); });
    }
    expect(dispatched).toEqual([{ type: "select", id: "pair" }, { type: "select", id: "pair" }, { type: "select", id: "pair" }]);
  });

  it("matches the conversation chip's keyboard foreground to hover", async () => {
    const [button] = await renderRows([sent]);
    const classes = new Set(button.className.split(/\s+/));
    expect(classes.has("hover:text-ink")).toBe(true);
    expect(classes.has("focus-visible:text-ink")).toBe(true);
  });

  it("draws the conversation and step chips flat, with a fill only on the button's hover and focus", async () => {
    const [button] = await renderRows([sent, { id: "step", at: 2, role: "bot", kind: "activity", tool: { name: "Bash: npm test", ok: true } }]);
    const row = host.querySelector(".font-mono")!.parentElement!;
    for (const chip of [button, row]) {
      const cls = new Set(chip.className.split(/\s+/));
      expect(cls.has("border-transparent")).toBe(true);
      expect([...cls].filter((c) => /^(bg-|border-hairline|rounded-(full|2xl))/.test(c))).toEqual([]);
    }
    for (const c of ["rounded-lg", "hover:bg-control", "focus-visible:bg-control", "hover:text-ink"]) expect(button.classList.contains(c)).toBe(true);
  });

  it("translates both labels into Korean in a room", async () => {
    localStorage.setItem("omb-locale", "ko");
    const chips = await renderRows([sent, reply]);
    expect(chips.map((chip) => chip.querySelector("span.truncate")?.textContent)).toEqual(["@Atlas에게 보낸 메시지", "@Atlas의 답장"]);
  });

  it("titles the chip in Korean in a room", async () => {
    localStorage.setItem("omb-locale", "ko");
    const chips = await renderRows([sent]);
    expect(chips[0].getAttribute("title")).toBe("Atlas 대화 열기");
  });

  it("shows handoff status lines in Korean in a room and as written in English", async () => {
    const line = (id: string, name: string): Message => ({ id, at: 1, role: "bot", kind: "activity", tool: { name, ok: false } });
    const rows = [
      line("denied", "Delegation to @Atlas denied by user"),
      line("failed", "error: delegation failed \u2014 Atlas is offline"),
      line("waiting", "Delegation to @Atlas waiting \u2014 they're busy (retry 1/3 when they finish)"),
      line("other", "error: the CLI exited"),
    ];
    const labels = () => Array.from(host.querySelectorAll(".border-transparent > span")).map((span) => span.textContent);
    await renderRows(rows);
    expect(labels()).toEqual([
      "Delegation to @Atlas denied by user",
      "error: delegation failed \u2014 Atlas is offline",
      "Delegation to @Atlas waiting \u2014 they're busy (retry 1/3 when they finish)",
      "error: the CLI exited",
    ]);
    await act(async () => { root.unmount(); });
    host.remove();
    localStorage.setItem("omb-locale", "ko");
    await renderRows(rows);
    expect(labels()).toEqual([
      "@Atlas에게 한 위임을 사용자가 거부했습니다",
      "오류: 위임 실패 - Atlas is offline",
      "@Atlas에게 한 위임 대기 중 - 상대가 작업 중입니다 (끝나면 1/3번째 재시도)",
      "error: the CLI exited",
    ]);
  });

  it("shows handoff status lines whole in the UI font and keeps commands mono and truncated", async () => {
    const line = (id: string, name: string): Message => ({ id, at: 1, role: "bot", kind: "activity", tool: { name, ok: false } });
    await renderRows([
      line("waiting", "Delegation to @Atlas waiting \u2014 they're busy (retry 1/3 when they finish)"),
      line("queued", "Queued for @Atlas, sends when this reply ends"),
      line("failed", "error: delegation failed \u2014 Atlas is offline"),
      line("bash", "Bash: npm test"),
    ]);
    const spans = Array.from(host.querySelectorAll(".border-transparent > span"));
    expect(spans.map((span) => span.className)).toEqual([
      "min-w-0 max-w-[480px] break-words",
      "min-w-0 max-w-[480px] break-words",
      "min-w-0 max-w-[480px] break-words",
      "min-w-0 max-w-[480px] truncate font-mono",
    ]);
  });

  it("translates Message from and the failed-turn fold labels into Korean in a room", async () => {
    localStorage.setItem("omb-locale", "ko");
    const received: Message = { id: "received", at: 1, role: "bot", kind: "activity", tool: { name: "Message from @Atlas" }, comm: { ...comm, peer: "from" } };
    const chips = await renderRows([received, { ...received, id: "old", comm }]);
    expect(chips.map((chip) => chip.querySelector("span.truncate")?.textContent)).toEqual(["@Atlas에게서 온 메시지", "@Atlas에게서 온 메시지"]);
    await act(async () => { root.unmount(); });
    host.remove();

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const failed: Message = { id: "a9", role: "bot", kind: "activity", tool: { name: "error: a long failure", ok: false }, at: 9 };
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(RoomToolChip, { message: failed, onRetry: () => {} })));
    });
    const toggle = () => [...host.querySelectorAll("button")].at(-1);
    expect(toggle()?.textContent).toBe("전체 메시지 보기");
    await act(async () => { toggle()?.click(); });
    expect(toggle()?.textContent).toBe("접기");
  });

  it("A rejected resend re-enables the Retry button", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    let capturedCallbacks: { onError?: () => void } | undefined;
    const onRetry = (callbacks?: { onError?: () => void }) => {
      capturedCallbacks = callbacks;
    };

    const message: Message = {
      id: "a1",
      role: "bot",
      kind: "activity",
      tool: { name: "error: failed", ok: false },
      at: 1,
    };

    await act(async () => {
      root.render(createElement(RoomToolChip, { message, onRetry }));
    });

    const button = host.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      button?.click();
    });

    expect(button?.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      capturedCallbacks?.onError?.();
    });

    expect(button?.hasAttribute("disabled")).toBe(false);
  });

  it("A failed turn offers Show full message and expands the truncated pill", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    const longError = `error: provider-private history is incompatible with the active route: reasoning replay rs_aaa:rs_bbb has no provider mapping, so this text runs long`;
    const message: Message = {
      id: "a9",
      role: "bot",
      kind: "activity",
      tool: { name: longError, ok: false },
      at: 9,
    };

    await act(async () => {
      root.render(createElement(RoomToolChip, { message, onRetry: () => {} }));
    });

    const pill = () => host.querySelector("span.max-w-\\[480px\\], span.break-words");
    expect(pill()?.className).toMatch(/truncate/);
    expect(host.textContent).toContain("Show full message");

    const toggle = [...host.querySelectorAll("button")].find((b) => b.textContent === "Show full message");
    expect(toggle).not.toBeUndefined();
    await act(async () => {
      toggle?.click();
    });

    expect(pill()?.className).not.toMatch(/truncate/);
    expect(host.textContent).toContain(longError);
    expect(host.textContent).toContain("Show less");

    const collapse = [...host.querySelectorAll("button")].find((b) => b.textContent === "Show less");
    await act(async () => {
      collapse?.click();
    });
    expect(pill()?.className).toMatch(/truncate/);
  });

  it("A setup error on the last activity from the sole responder: exposes the same action setupErrorAction gives 1:1", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    const botAlice = {
      id: "b1",
      name: "Alice",
      color: "blue",
      modelSelection: { model: "claude-3-7-sonnet", instanceId: "claude" },
    } as unknown as Bot;
    const claudeInstance = {
      instanceId: "claude",
      driverKind: "claudeAgent",
      displayName: "Claude",
      models: { default: "claude-3-7-sonnet", options: [] },
      install: {
        command: { win32: "npm install -g @anthropic-ai/claude-code", darwin: "npm i", linux: "npm i" },
      },
      snapshot: { state: "unavailable", reason: "`claude` CLI not found" },
    } as unknown as InstanceInfo;
    mockState = {
      bots: [botAlice],
      instances: [claudeInstance],
    };

    const cliMessage: Message = {
      id: "a1",
      role: "bot",
      kind: "activity",
      tool: { name: "error: claude cli missing", ok: false, setup: true },
      from: { botId: "b1", name: "Alice", color: "blue" as any },
      at: 2,
    };

    const prevOgb = window.ogb;
    window.ogb = { platform: "win32" } as any;
    try {
      await act(async () => {
        root.render(createElement(RoomToolChip, { message: cliMessage, onRetry: () => {} }));
      });

      // 1:1 setupErrorAction gives "cli", which renders EngineSetup with install action
      expect(host.querySelector("code")?.textContent).toBe(claudeInstance.install?.command?.win32);
      expect(host.textContent).toContain("Copy Command");
    } finally {
      window.ogb = prevOgb;
    }

    // Without onRetry/canSetup (not sole responder or not last activity), no setup action exposed
    await act(async () => {
      root.render(createElement(RoomToolChip, { message: cliMessage }));
    });

    expect(host.querySelector("button")).toBeNull();
  });
});
