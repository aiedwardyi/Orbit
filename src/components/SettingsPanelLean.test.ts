// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {
        instances: [
          {
            instanceId: "claude",
            driverKind: "claudeAgent",
            displayName: "Claude",
            snapshot: { state: "available", authenticated: true, version: "1.0.13" },
            models: { default: "claude-3-5-sonnet", options: [{ id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" }] },
            capabilities: {},
          },
        ],
        bots: [],
        config: {},
        mascotMotion: null,
      },
      dispatch: mockDispatch,
      refreshInstances: async () => undefined,
    }),
  };
});

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "other", homeDir: undefined },
      toasts: { available: false },
      localComputer: { available: false, support: "unsupported" },
    },
    ready: true,
  }),
}));

vi.mock("./VoiceSettings", () => ({
  VoiceSettings: () => null,
}));

vi.mock("./BotProfileAvatarCard", () => ({
  BotProfileAvatarCard: () => null,
}));

vi.mock("./LocalComputerAutoWarning", () => ({
  LocalComputerAutoWarning: ({ open }: { open: boolean }) => (open ? createElement("div", { "data-local-warning": "" }) : null),
}));

vi.mock("./CloudBackendPicker", () => ({
  CloudBackendPicker: () => null,
}));

import { SettingsPanel } from "./SettingsPanel";

const claudeBot = {
  id: "bot-1",
  threadId: "t1",
  name: "Friend",
  title: "",
  description: "",
  notifications: false,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "claude-3-5-sonnet", mode: "automatic" },
  messages: [],
} as Bot;

describe("SettingsPanel lean startup switch", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mockDispatch.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    (window as any).ogb = {};
  });

  afterEach(() => {
    root.unmount();
    host.remove();
  });

  it("off saves leanStartup true", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })));
    });
    const toggle = host.querySelector('button[aria-label="Load skills & plugins"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      (toggle as HTMLButtonElement)?.click();
    });
    expect(mockDispatch).toHaveBeenCalledWith({
      type: "updateBot",
      botId: "bot-1",
      patch: { leanStartup: true },
    });
  });

  it("on saves leanStartup false", async () => {
    await act(async () => {
      root.render(
        createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, leanStartup: true } as Bot })),
      );
    });
    const toggle = host.querySelector('button[aria-label="Load skills & plugins"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      (toggle as HTMLButtonElement)?.click();
    });
    expect(mockDispatch).toHaveBeenCalledWith({
      type: "updateBot",
      botId: "bot-1",
      patch: { leanStartup: false },
    });
  });
});

describe("SettingsPanel approval pill", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const option = (label: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Approval"] button')).find(
      (button) => button.textContent === label,
    )!;

  beforeEach(() => {
    mockDispatch.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    root.unmount();
    host.remove();
  });

  it("shows Ask for an unset bot outside Advanced and switches to Auto", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })));
    });
    expect(option("Ask").getAttribute("aria-checked")).toBe("true");
    expect(option("Auto").getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector('[aria-label="Auto mode"]')).toBeNull();
    await act(async () => option("Auto").click());
    expect(mockDispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "bot-1", patch: { autoApprove: true } });
  });

  it("switches an Auto bot back to Ask", async () => {
    await act(async () => {
      root.render(
        createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, autoApprove: true } as Bot })),
      );
    });
    expect(option("Auto").getAttribute("aria-checked")).toBe("true");
    await act(async () => option("Ask").click());
    expect(mockDispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "bot-1", patch: { autoApprove: false } });
  });

  it("warns before Auto on a bot that drives this computer", async () => {
    await act(async () => {
      root.render(
        createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, computer: "local" } as Bot })),
      );
    });
    await act(async () => option("Auto").click());
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(host.querySelector("[data-local-warning]")).not.toBeNull();
  });
});

describe("SettingsPanel memory and order", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ text: "likes tea", truncated: false, topics: [] }))),
    );
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    vi.unstubAllGlobals();
  });

  it("loads memory on mount with no click", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })));
    });
    const box = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Memory"]');
    expect(box?.value).toBe("likes tea");
    expect(host.querySelector('button[aria-expanded][class*="justify-between"]')).toBeNull();
  });

  it("orders the detail rows with lean startup after the terminal share", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })));
    });
    const text = host.textContent ?? "";
    const order = ["Title", "Description", "Memory", "Project folder", "Approval", "Notifications", "Share terminal with chat", "Load skills & plugins"];
    const at = order.map((label) => text.indexOf(label));
    expect(at).not.toContain(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

interface Put {
  url: string;
  text: string;
  keepalive?: boolean;
  resolve: (response: Response) => void;
}

describe("SettingsPanel memory autosave", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let puts: Put[];
  let held: boolean;

  const ok = () => new Response(JSON.stringify({ ok: true, truncated: false }));
  const render = async (id: string) => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, id, threadId: `t-${id}` } })));
    });
  };
  const box = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Memory"]')!;
  const status = () => host.querySelector('[role="status"]')?.textContent ?? "";
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), value);
      box().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const wait = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const land = async (put: Put, response = ok()) => {
    await act(async () => {
      put.resolve(response);
      await vi.advanceTimersByTimeAsync(0);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mockDispatch.mockClear();
    puts = [];
    held = false;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          const text: string = JSON.parse(String(init.body)).text;
          return new Promise<Response>((resolve) => {
            const put = { url, text, keepalive: init.keepalive, resolve };
            puts.push(put);
            if (!held) resolve(ok());
          });
        }
        if (url.includes("/memory/topics/")) return new Response(JSON.stringify({ name: "prefs.md", text: "tea" }));
        return new Response(
          JSON.stringify({ text: `notes for ${url.split("/")[3]}`, truncated: false, topics: [{ name: "prefs.md", bytes: 3 }] }),
        );
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("has no Save button under the memory editor", async () => {
    await render("bot-1");
    const buttons = Array.from(box().parentElement!.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).not.toContain("Save");
  });

  it("puts the latest text once after typing pauses", async () => {
    await render("bot-1");
    await type("likes tea");
    await wait(500);
    await type("likes tea and jazz");
    await wait(799);
    expect(puts).toHaveLength(0);
    await wait(1);
    expect(puts.map((put) => [put.url, put.text])).toEqual([["/api/bots/bot-1/memory", "likes tea and jazz"]]);
    await wait(5000);
    expect(puts).toHaveLength(1);
  });

  it("saves at once on blur", async () => {
    await render("bot-1");
    await type("likes tea");
    await act(async () => {
      box().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(puts.map((put) => put.text)).toEqual(["likes tea"]);
  });

  it("saves at once when the page hides", async () => {
    await render("bot-1");
    await type("likes tea");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(puts.map((put) => put.text)).toEqual(["likes tea"]);
  });

  it("saves to its own bot when unmounted mid-pause", async () => {
    await render("bot-1");
    await type("likes tea");
    act(() => root.unmount());
    expect(puts.map((put) => [put.url, put.text])).toEqual([["/api/bots/bot-1/memory", "likes tea"]]);
    root = createRoot(host);
  });

  it("never writes one bot's text into another bot on a switch", async () => {
    await render("bot-1");
    await type("bot one notes");
    await render("bot-2");
    expect(box().value).toBe("notes for bot-2");
    await wait(5000);
    expect(puts.map((put) => [put.url, put.text])).toEqual([["/api/bots/bot-1/memory", "bot one notes"]]);
  });

  it("writes nothing without an edit", async () => {
    await render("bot-1");
    await act(async () => {
      box().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("button[class*='last:border-b-0']")!.click();
    });
    expect(host.textContent).toContain("memory/prefs.md");
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Back")!.click();
    });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await render("bot-2");
    await wait(5000);
    act(() => root.unmount());
    root = createRoot(host);
    expect(puts).toHaveLength(0);
  });

  it("keeps newer text unsaved when an older write lands", async () => {
    held = true;
    await render("bot-1");
    await type("likes tea");
    await wait(800);
    expect(puts.map((put) => put.text)).toEqual(["likes tea"]);
    await type("likes tea and jazz");
    await land(puts[0]);
    expect(status()).toBe("Saving…");
    await wait(800);
    expect(puts.map((put) => put.text)).toEqual(["likes tea", "likes tea and jazz"]);
    await land(puts[1]);
    expect(status()).toBe("Saved");
  });

  it("sends text typed during a write in the next write", async () => {
    held = true;
    await render("bot-1");
    await type("likes tea");
    await wait(800);
    await type("likes tea and jazz");
    await wait(800);
    expect(puts).toHaveLength(1);
    await land(puts[0]);
    expect(puts.map((put) => put.text)).toEqual(["likes tea", "likes tea and jazz"]);
  });

  it("keeps the text and shows the message when a write fails", async () => {
    held = true;
    await render("bot-1");
    await type("x".repeat(40));
    await wait(800);
    await land(puts[0], new Response(JSON.stringify({ error: "memory is capped at 256KB" }), { status: 400 }));
    expect(box().value).toBe("x".repeat(40));
    expect(host.querySelector(".text-danger")?.textContent).toBe("memory is capped at 256KB");
    expect(status()).toBe("");
    await type("x".repeat(20));
    await wait(800);
    expect(puts.map((put) => put.text)).toEqual(["x".repeat(40), "x".repeat(20)]);
  });

  it("retries a failed write on the next blur and on close", async () => {
    held = true;
    const down = () => new Response(JSON.stringify({ error: "offline" }), { status: 503 });
    await render("bot-1");
    await type("likes tea");
    await wait(800);
    await land(puts[0], down());
    await wait(5000);
    expect(puts).toHaveLength(1);
    await act(async () => {
      box().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(puts.map((put) => put.text)).toEqual(["likes tea", "likes tea"]);
    await land(puts[1], down());
    act(() => root.unmount());
    root = createRoot(host);
    expect(puts.map((put) => put.text)).toEqual(["likes tea", "likes tea", "likes tea"]);
  });

  it("saves on pagehide with a write that outlives the page", async () => {
    await render("bot-1");
    await type("likes tea");
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(puts.map((put) => [put.text, put.keepalive])).toEqual([["likes tea", true]]);
  });

  it("drops keepalive for memory over 64 KB", async () => {
    await render("bot-1");
    await type("메".repeat(22_000));
    await wait(800);
    expect(puts.map((put) => put.keepalive)).toEqual([false]);
  });

  it("reports a write that fails after the panel closed", async () => {
    held = true;
    await render("bot-1");
    await type("likes tea");
    act(() => root.unmount());
    root = createRoot(host);
    await land(puts[0], new Response(JSON.stringify({ error: "disk full" }), { status: 500 }));
    expect(mockDispatch).toHaveBeenCalledWith({ type: "error", message: "disk full" });
  });

  it("shows Saving then Saved then nothing", async () => {
    held = true;
    await render("bot-1");
    expect(status()).toBe("");
    await type("likes tea");
    expect(status()).toBe("Saving…");
    await wait(800);
    expect(status()).toBe("Saving…");
    await land(puts[0]);
    expect(status()).toBe("Saved");
    await wait(2000);
    expect(status()).toBe("");
  });
});
