// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ReplyQuote } from "./ReplyQuote";
import type { Message } from "@/state/store";

describe("ReplyQuote", () => {
  it("strips pasted-text wrapper tags from the reply quote snippet", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    afterEach(() => {
      root.unmount();
      host.remove();
    });
    const raw = '<pasted-text index="1">\nquoted message text\n</pasted-text>';
    const message: Message = { id: "m1", role: "user", kind: "text", text: raw, at: 1 };

    await act(async () => {
      root.render(createElement(ReplyQuote, { message }));
    });

    expect(host.textContent).not.toContain("<pasted-text");
    expect(host.textContent).toContain("quoted message text");
  });
});
