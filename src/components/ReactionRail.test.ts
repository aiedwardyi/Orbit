import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const sources = {
  "ChatView.tsx": readFileSync(join(here, "ChatView.tsx"), "utf8"),
  "GroupView.tsx": readFileSync(join(here, "GroupView.tsx"), "utf8"),
} as const;

describe("reaction rail", () => {
  // The leading "{" is load-bearing: the bot-side "{!user && …" contains the user-side text.
  it("drops the picker rail from user messages in ChatView", () => {
    expect(sources["ChatView.tsx"]).not.toContain('{user && message.kind === "text" && <ReactionBar');
  });

  it("keeps the picker rail on bot messages in ChatView", () => {
    expect(sources["ChatView.tsx"]).toContain('{!user && message.kind === "text" && <ReactionBar');
    expect(sources["ChatView.tsx"]).toContain("<ReactionChips threadId={bot.threadId}");
  });

  it("drops the picker rail from user messages in GroupView", () => {
    expect(sources["GroupView.tsx"]).not.toContain("{user && <ReactionBar threadId={group.threadId} message={m} />}");
  });

  it("keeps the picker rail on bot messages in GroupView", () => {
    expect(sources["GroupView.tsx"]).toContain("<ReactionBar threadId={group.threadId} message={m} />");
    expect(sources["GroupView.tsx"]).toContain("<ReactionChips threadId={group.threadId}");
  });
});
