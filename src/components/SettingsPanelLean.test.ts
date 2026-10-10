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
  base?: string;
  keepalive?: boolean;
  response?: Response;
  resolve: (response: Response) => void;
}

describe("SettingsPanel memory autosave", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let puts: Put[];
  let held: boolean;
  let served: Record<string, string>;

  const ok = (text: string) => new Response(JSON.stringify({ ok: true, truncated: false, revision: `r:${text}` }));
  const render = async (id: string) => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, id, threadId: `t-${id}` } })));
    });
  };
  const box = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Memory"]')!;
  const status = () => host.querySelector('[role="status"]')?.textContent ?? "";
  const notice = () => host.querySelector('[role="alert"]')?.firstElementChild?.textContent ?? "";
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find((each) => each.textContent === label)!;
  const stored = (id: string) => JSON.parse(localStorage.getItem(`omb-memory-draft:${id}`) ?? "null");
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
  const land = async (put: Put, response = put.response ?? ok(put.text)) => {
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
    served = {};
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          const { text, baseRevision } = JSON.parse(String(init.body));
          return new Promise<Response>((resolve) => {
            const put = { url, text, base: baseRevision, keepalive: init.keepalive, resolve };
            puts.push(put);
            if (!held) resolve(ok(text));
          });
        }
        if (url.includes("/memory/topics/")) return new Response(JSON.stringify({ name: "prefs.md", text: "tea" }));
        const id = url.split("/")[3];
        const text = served[id] ?? `notes for ${id}`;
        return new Response(JSON.stringify({ text, truncated: false, revision: `r:${text}`, topics: [{ name: "prefs.md", bytes: 3 }] }));
      }),
    );
  });

  afterEach(async () => {
    act(() => root.unmount());
    // drafts and saves outlive a panel, so settle them before the next test
    for (let i = 0; i < puts.length; i++) await land(puts[i]);
    localStorage.clear();
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
    await render("bot-cap");
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
    await render("bot-retry");
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
    await render("bot-closed");
    await type("likes tea");
    act(() => root.unmount());
    root = createRoot(host);
    await land(puts[0], new Response(JSON.stringify({ error: "disk full" }), { status: 500 }));
    expect(mockDispatch).toHaveBeenCalledWith({ type: "error", message: "disk full" });
  });

  it("brings back a write that failed after the panel closed and saves it", async () => {
    held = true;
    await render("bot-reopen");
    await type("likes tea");
    act(() => root.unmount());
    root = createRoot(host);
    await land(puts[0], new Response(JSON.stringify({ error: "offline" }), { status: 503 }));
    await render("bot-reopen");
    expect(box().value).toBe("likes tea");
    expect(status()).toBe("Saving…");
    await wait(800);
    expect(puts.map((put) => [put.url, put.text])).toEqual([
      ["/api/bots/bot-reopen/memory", "likes tea"],
      ["/api/bots/bot-reopen/memory", "likes tea"],
    ]);
    await land(puts[1]);
    expect(status()).toBe("Saved");
    act(() => root.unmount());
    root = createRoot(host);
    await render("bot-reopen");
    expect(box().value).toBe("notes for bot-reopen");
  });

  it("brings back a failed write only to its own bot after a switch", async () => {
    held = true;
    await render("bot-away");
    await type("likes tea");
    await render("bot-2");
    await land(puts[0], new Response(JSON.stringify({ error: "offline" }), { status: 503 }));
    expect(box().value).toBe("notes for bot-2");
    await render("bot-away");
    expect(box().value).toBe("likes tea");
    await wait(800);
    expect(puts.map((put) => [put.url, put.text])).toEqual([
      ["/api/bots/bot-away/memory", "likes tea"],
      ["/api/bots/bot-away/memory", "likes tea"],
    ]);
    await land(puts[1]);
  });

  it("shows the conflict for a failed write when the memory changed since", async () => {
    held = true;
    const down = () => new Response(JSON.stringify({ error: "offline" }), { status: 503 });
    await render("bot-moved");
    await type("likes tea");
    act(() => root.unmount());
    root = createRoot(host);
    await land(puts[0], down());
    served["bot-moved"] = "likes coffee";
    await render("bot-moved");
    expect(box().value).toBe("likes tea");
    expect(notice()).toBe("This memory changed somewhere else.");
    expect(status()).toBe("");
    await wait(5000);
    expect(puts).toHaveLength(1);
    await act(async () => button("Load latest").click());
    expect(box().value).toBe("likes coffee");
    await type("likes coffee and jazz");
    act(() => root.unmount());
    root = createRoot(host);
    await land(puts[1], down());
    await render("bot-moved");
    expect(box().value).toBe("likes coffee and jazz");
    await wait(800);
    await land(puts[2]);
    expect(puts.map((put) => [put.text, put.base])).toEqual([
      ["likes tea", "r:notes for bot-moved"],
      ["likes coffee and jazz", "r:likes coffee"],
      ["likes coffee and jazz", "r:likes coffee"],
    ]);
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

  // the server's own MEMORY.md read and compare-and-write behind fetch; a held save has already written
  const files = async () => {
    const workspace = await import("../../server/workspace.ts");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const id = url.split("/")[3];
        if (init?.method !== "PUT") return new Response(JSON.stringify({ ...workspace.readMemoryFile(id), topics: [] }));
        const { text, baseRevision } = JSON.parse(String(init.body));
        const saved = workspace.saveMemoryFile(id, text, baseRevision);
        const response = saved.conflict
          ? new Response(JSON.stringify({ error: "conflict", text: saved.text, revision: saved.revision }), { status: 409 })
          : new Response(JSON.stringify({ ok: true, truncated: saved.truncated, revision: saved.revision }));
        return new Promise<Response>((resolve) => {
          puts.push({ url, text, base: baseRevision, keepalive: init.keepalive, response, resolve });
          if (!held) resolve(response);
        });
      }),
    );
    return workspace;
  };

  it("refuses a save over memory that changed on disk and keeps the edit", async () => {
    const { readMemoryFile, writeMemoryFile } = await files();
    writeMemoryFile("bot-remote", "base memory");
    await render("bot-remote");
    writeMemoryFile("bot-remote", "newer remote memory");
    await type("base memory plus local edit");
    await wait(800);
    expect(readMemoryFile("bot-remote").text).toBe("newer remote memory");
    expect(box().value).toBe("base memory plus local edit");
    expect(notice()).toBe("This memory changed somewhere else.");
    expect(status()).toBe("");
    await type("base memory plus more");
    await wait(5000);
    expect(puts).toHaveLength(1);
  });

  it("never lets a closed panel's queued save overwrite a newer edit after reopening", async () => {
    held = true;
    const { readMemoryFile, writeMemoryFile } = await files();
    writeMemoryFile("bot-requeue", "base memory");
    await render("bot-requeue");
    await type("old in flight");
    await wait(800);
    await type("old queued");
    act(() => root.unmount());
    root = createRoot(host);
    await render("bot-requeue");
    await type("newer edit after reopen");
    await wait(800);
    await land(puts[0]);
    await land(puts[1]);
    expect(readMemoryFile("bot-requeue").text).toBe("newer edit after reopen");
    expect(box().value).toBe("newer edit after reopen");
    expect(status()).toBe("Saved");
    expect(puts.map((put) => put.text)).toEqual(["old in flight", "newer edit after reopen"]);
  });

  it("keeps the latest edit stored when the page closes during a save", async () => {
    held = true;
    await render("bot-pagehide");
    await type("old in flight");
    await wait(800);
    await type("latest draft");
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(puts.map((put) => put.text)).toEqual(["old in flight"]);
    expect(stored("bot-pagehide")).toEqual({ text: "latest draft", base: "r:notes for bot-pagehide" });
    await land(puts[0]);
    expect(stored("bot-pagehide")).toEqual({ text: "latest draft", base: "r:old in flight" });
  });

  it("saves a stored draft quietly after a reload when the memory is unchanged", async () => {
    held = true;
    localStorage.setItem("omb-memory-draft:bot-reload", JSON.stringify({ text: "likes tea", base: "r:notes for bot-reload" }));
    await render("bot-reload");
    expect(box().value).toBe("likes tea");
    expect(status()).toBe("Saving…");
    expect(notice()).toBe("");
    expect(puts.map((put) => [put.text, put.base])).toEqual([["likes tea", "r:notes for bot-reload"]]);
    await land(puts[0]);
    expect(status()).toBe("Saved");
    expect(stored("bot-reload")).toBeNull();
  });

  it("shows the conflict for a stored draft made from older memory", async () => {
    localStorage.setItem("omb-memory-draft:bot-stale", JSON.stringify({ text: "likes tea", base: "r:older notes" }));
    await render("bot-stale");
    expect(box().value).toBe("likes tea");
    expect(notice()).toBe("This memory changed somewhere else.");
    expect(status()).toBe("");
    await wait(5000);
    expect(puts).toHaveLength(0);
    expect(stored("bot-stale")).toEqual({ text: "likes tea", base: "r:older notes" });
  });

  it("Load latest drops the edit and shows the file", async () => {
    const { readMemoryFile, writeMemoryFile } = await files();
    writeMemoryFile("bot-latest", "base memory");
    await render("bot-latest");
    writeMemoryFile("bot-latest", "newer remote memory");
    await type("my edit");
    await wait(800);
    await act(async () => button("Load latest").click());
    expect(box().value).toBe("newer remote memory");
    expect(notice()).toBe("");
    expect(stored("bot-latest")).toBeNull();
    expect(readMemoryFile("bot-latest").text).toBe("newer remote memory");
    await type("newer remote memory plus mine");
    await wait(800);
    expect(readMemoryFile("bot-latest").text).toBe("newer remote memory plus mine");
    expect(status()).toBe("Saved");
  });

  it("Keep mine saves the edit over the file", async () => {
    const { readMemoryFile, writeMemoryFile } = await files();
    writeMemoryFile("bot-mine", "base memory");
    await render("bot-mine");
    writeMemoryFile("bot-mine", "newer remote memory");
    await type("my edit");
    await wait(800);
    await act(async () => button("Keep mine").click());
    expect(readMemoryFile("bot-mine").text).toBe("my edit");
    expect(box().value).toBe("my edit");
    expect(notice()).toBe("");
    expect(status()).toBe("Saved");
    expect(stored("bot-mine")).toBeNull();
  });

  it("re-reads memory on focus or return with nothing unsaved", async () => {
    await render("bot-fresh");
    served["bot-fresh"] = "written by the bot";
    await act(async () => {
      box().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(box().value).toBe("written by the bot");
    served["bot-fresh"] = "synced from the other PC";
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(box().value).toBe("synced from the other PC");
    await type("my edit");
    served["bot-fresh"] = "newest";
    await act(async () => {
      box().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(box().value).toBe("my edit");
    await wait(800);
    expect(puts.map((put) => [put.text, put.base])).toEqual([["my edit", "r:synced from the other PC"]]);
  });
});
