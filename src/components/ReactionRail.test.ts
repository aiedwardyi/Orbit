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

function reactionBarSource() {
  const start = sources["Reactions.tsx"].indexOf("export function ReactionBar");
  const end = sources["Reactions.tsx"].indexOf("export function ReactionChips");
  return sources["Reactions.tsx"].slice(start, end);
}

describe("reaction rail", () => {
  it("drops the picker from user messages in ChatView", () => {
    expect(sources["ChatView.tsx"]).not.toContain('{user && message.kind === "text" && <ReactionBar');
  });

  it("keeps the picker on bot messages in ChatView", () => {
    expect(sources["ChatView.tsx"]).toContain("<ReactionBar threadId={bot.threadId} message={message} />");
    expect(sources["ChatView.tsx"]).toContain("<ReactionChips threadId={bot.threadId}");
  });

  it("drops the picker from user messages in GroupView", () => {
    expect(sources["GroupView.tsx"]).not.toContain("{user && <ReactionBar threadId={group.threadId} message={m} />}");
  });

  it("keeps the picker on bot messages in GroupView", () => {
    expect(sources["GroupView.tsx"]).toContain("<ReactionBar threadId={group.threadId} message={m} />");
    expect(sources["GroupView.tsx"]).toContain("<ReactionChips threadId={group.threadId}");
  });

  it("folds copy, reply, pin, and regenerate into one horizontal hover row", () => {
    expect(sources["ChatView.tsx"]).not.toContain("flex flex-col gap-0.5 self-end");
    expect(sources["ChatView.tsx"]).toContain("data-message-hover-actions");
    expect(sources["GroupView.tsx"]).toContain("data-message-hover-actions");
    // the assistant row in ChatView docks bottom-right of the bubble instead
    // of mirroring the user row's vertically-centered float
    expect(sources["ChatView.tsx"]).toContain("right-full");
    expect(sources["GroupView.tsx"]).toContain("left-full");
    expect(sources["GroupView.tsx"]).toContain("right-full");
    const chatRows = sources["ChatView.tsx"].split("data-message-hover-actions").slice(1);
    expect(chatRows.length).toBeGreaterThanOrEqual(2);
    expect(chatRows.every((row) => row.includes("items-center"))).toBe(true);
  });

  it("reveals the hover row on group hover and keyboard focus, not as a permanent tray", () => {
    for (const file of ["ChatView.tsx", "GroupView.tsx"] as const) {
      const src = sources[file];
      const idxs: number[] = [];
      for (let i = src.indexOf("data-message-hover-actions"); i !== -1; i = src.indexOf("data-message-hover-actions", i + 1)) {
        idxs.push(i);
      }
      expect(idxs.length).toBeGreaterThanOrEqual(2);
      for (const idx of idxs) {
        const slice = src.slice(idx, idx + 500);
        expect(slice).toContain("group-hover:opacity-100");
        expect(slice).toContain("group-focus-within:opacity-100");
        if (slice.includes("ReactionBar")) {
          // the picker is portalled away, so the open trigger is what holds the row
          expect(slice).toContain("has-[[aria-expanded=true]]:pointer-events-auto");
          expect(slice).toContain("has-[[aria-expanded=true]]:opacity-100");
        }
        expect(slice).toContain("opacity-0");
      }
    }
  });

  it("puts thumbs up, down, and heart in the picker, not an open tray", () => {
    expect(sources["reactions.ts"]).toMatch(/👍[\s\S]*👎[\s\S]*❤️/);
    const bar = reactionBarSource();
    expect(bar).toContain("data-reaction-bar");
    expect(bar).toContain("SmilePlus");
    expect(bar).toContain("data-reaction-picker");
    // portalled to the root so no ancestor clip or stacking context reaches it
    expect(bar).toContain("createPortal");
    expect(bar).toContain("fixed z-40");
    const trigger = bar.slice(0, bar.indexOf("data-reaction-picker"));
    expect(trigger).not.toContain("PRIMARY_REACTIONS.map");
    expect(trigger).not.toContain("EXTENDED_REACTIONS.map");
    expect(bar).toContain("EXTENDED_REACTIONS.map");
    expect(bar).toContain("toggleReaction");
    expect(bar).toContain("aria-pressed");
    expect(bar).toContain('t("chat.moreReactions")');
    expect(sources["Reactions.tsx"]).toContain('t("chat.reactEmoji"');
    expect(bar).toMatch(/const mine = useMemo\(/);
    expect(bar).not.toContain("export const REACTION_SET");
  });

  it("keeps the picker on screen when the gutter is thinner than the grid", () => {
    const bar = reactionBarSource();
    expect(bar).toContain("useLayoutEffect");
    // measured off the anchor, so a resize cannot compound the offset
    expect(bar).toContain("anchorRef.current?.getBoundingClientRect()");
    expect(bar).not.toContain("pickerRef.current?.getBoundingClientRect()");
    expect(bar).toContain('window.addEventListener("resize", clamp)');
    expect(bar).toContain('window.removeEventListener("resize", clamp)');
    expect(bar).toContain("window.innerWidth");
  });

  it("keeps bubbly picker icons and the existing dismiss contract", () => {
    const bar = reactionBarSource();
    expect(bar).toContain("size-7");
    expect(bar).toContain("rounded-full");
    expect(bar).toContain("hover:scale-110");
    expect(bar).toContain("setPickerOpen(false)");
    expect(bar).toContain("Escape");
    expect(bar).toContain("aria-expanded");
  });
});
