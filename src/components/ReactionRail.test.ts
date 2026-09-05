import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const sources = {
  "ChatView.tsx": readFileSync(join(here, "ChatView.tsx"), "utf8"),
  "GroupView.tsx": readFileSync(join(here, "GroupView.tsx"), "utf8"),
  "Reactions.tsx": readFileSync(join(here, "Reactions.tsx"), "utf8"),
  "reactions.ts": readFileSync(join(here, "../../shared/reactions.ts"), "utf8"),
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

  it("puts thumbs up, down, and heart on the visible Friends rail", () => {
    expect(sources["Reactions.tsx"]).toContain('PRIMARY_REACTIONS');
    expect(sources["reactions.ts"]).toMatch(/👍[\s\S]*👎[\s\S]*❤️/);
    expect(sources["Reactions.tsx"]).toContain('data-reaction-bar');
  });

  it("keeps the bubbly rail tappable without hover-only opacity", () => {
    const rail = sources["Reactions.tsx"];
    expect(rail).not.toMatch(/data-reaction-bar[\s\S]{0,240}opacity-0/);
    expect(rail).toContain('aria-pressed');
    expect(rail).toContain('t("chat.moreReactions")');
    expect(rail).toContain('t("chat.reactEmoji"');
    expect(rail).toMatch(/const mine = useMemo\(/);
    expect(rail).not.toContain("export const REACTION_SET");
  });

  it("quiets tray chrome without shrinking hit targets or dropping the rail", () => {
    const start = sources["Reactions.tsx"].indexOf("export function ReactionBar");
    const end = sources["Reactions.tsx"].indexOf("export function ReactionChips");
    const bar = sources["Reactions.tsx"].slice(start, end);
    expect(bar).toContain("data-reaction-bar");
    expect(bar).toContain("size-7");
    expect(bar).toContain("rounded-full");
    expect(bar).toContain("hover:scale-110");
    expect(bar).toContain("toggleReaction");
    expect(bar).toContain("mt-0.5");
    expect(bar).not.toContain("shadow-[0_4px_14px_rgba(0,0,0,0.16)]");
    const tray = bar.slice(bar.indexOf("data-reaction-bar"), bar.indexOf("data-reaction-picker"));
    expect(tray).toContain("border-hairline/35");
    expect(tray).toContain("bg-card/75");
    expect(tray).not.toContain("border-hairline/50");
    expect(tray).not.toContain("bg-card/95");
    expect(tray).not.toContain("border-hairline/20");
    expect(tray).not.toContain("bg-card/50");
  });
});
