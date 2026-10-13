// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PinnedBanner } from "./ChatView";
import type { Message } from "@/state/store";

describe("PinnedBanner", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  afterEach(() => {
    root.unmount();
    host.remove();
  });

  it("strips pasted-text wrapper tags from the pinned message banner", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const raw = '<pasted-text index="1">\nimportant pinned note\n</pasted-text>';
    const pinned: Message = { id: "p1", role: "user", kind: "text", text: raw, at: 1 };
    const bot = { name: "Bot", threadId: "t1" };

    await act(async () => {
      root.render(
        createElement(PinnedBanner, {
          bot,
          pinnedId: "p1",
          messages: [pinned],
          onJump: () => {},
          onUnpin: () => {},
        }),
      );
    });

    expect(host.textContent).not.toContain("<pasted-text");
    expect(host.textContent).toContain("important pinned note");
  });

  it.each([
    [
      "**Team phone setup codes.**\nEach one works once, until Oct 26.\nTeammate 1:\n```text\nwks1:example-code\n```",
      "Team phone setup codes. Each one works once, until Oct 26. Teammate 1:",
    ],
    ["## Setup\nUse `phone setup` from [the guide](https://example.test/setup).", "Setup Use phone setup from the guide."],
    ['<pasted-text index="1">\n__Important__\n*read this*\n</pasted-text>', "Important read this"],
  ])("shows markdown as plain text: %s", async (raw, plain) => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(PinnedBanner, {
        bot: { name: "Bot", threadId: "t1" },
        pinnedId: "p1",
        messages: [{ id: "p1", role: "bot", kind: "text", text: raw, at: 1 }],
        onJump: () => {},
        onUnpin: () => {},
      }));
    });
    expect(host.querySelector("span.truncate")?.textContent).toBe(plain);
  });

  it("keeps long plain previews bounded by the bar's ellipsis", async () => {
    const plain = `Team phone setup codes. ${"Each one works once. ".repeat(20)}`.trim();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(PinnedBanner, {
        bot: { name: "Bot", threadId: "t1" },
        pinnedId: "p1",
        messages: [{ id: "p1", role: "bot", kind: "text", text: `**${plain}**`, at: 1 }],
        onJump: () => {},
        onUnpin: () => {},
      }));
    });
    const preview = host.querySelector("span.truncate");
    expect(preview?.textContent).toBe(plain);
    expect(preview?.classList.contains("truncate")).toBe(true);
  });

  it("keeps a code-only pin visible", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(PinnedBanner, {
        bot: { name: "Bot", threadId: "t1" },
        pinnedId: "p1",
        messages: [{ id: "p1", role: "bot", kind: "text", text: "```bash\npnpm install\n```", at: 1 }],
        onJump: () => {},
        onUnpin: () => {},
      }));
    });
    expect(host.querySelector("span.truncate")?.textContent).toBe("pnpm install");
  });
});

describe("PinnedBanner on a paged transcript", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("fetches a pinned message older than every loaded page", async () => {
    const pinned: Message = { id: "old", role: "user", kind: "text", text: "pinned long ago", at: 1 };
    const fetch = vi.fn(async () => Response.json({ messages: [pinned], hasMore: true }));
    vi.stubGlobal("fetch", fetch);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(PinnedBanner, {
          bot: { name: "Bot", threadId: "t1", hasMore: true },
          pinnedId: "old",
          messages: [{ id: "new", role: "user", kind: "text", text: "recent", at: 2 }],
          onJump: () => {},
          onUnpin: () => {},
        }),
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain("pinned long ago"));
    expect(fetch).toHaveBeenCalledWith("/api/threads/t1/messages?around=old&limit=1", expect.anything());
    await act(async () => root.unmount());
  });
});
