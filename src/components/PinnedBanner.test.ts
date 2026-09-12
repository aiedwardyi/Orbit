// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { PinnedBanner } from "./ChatView";
import type { Message } from "@/state/store";

describe("PinnedBanner", () => {
  it("strips pasted-text wrapper tags from the pinned message banner", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    afterEach(() => {
      root.unmount();
      host.remove();
    });
    const raw = '<pasted-text index="1">\nimportant pinned note\n</pasted-text>';
    const pinned: Message = { id: "p1", role: "user", kind: "text", text: raw, at: 1 };
    const bot = { name: "Bot" };

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
});
