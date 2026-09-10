import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const components = join(here, "../components");
const chatView = readFileSync(join(components, "ChatView.tsx"), "utf8");
const groupView = readFileSync(join(components, "GroupView.tsx"), "utf8");
const composer = readFileSync(join(components, "Composer.tsx"), "utf8");

describe("chat TTS speaker chrome", () => {
  it("does not render a per-message speak button", () => {
    expect(chatView).not.toContain("SpeakButton");
    expect(chatView).not.toMatch(/Read this aloud/);
    expect(groupView).not.toContain("SpeakButton");
    expect(composer).not.toContain("SpeakButton");
  });

  it("does not leave a dead SpeakButton module", () => {
    expect(existsSync(join(components, "SpeakButton.tsx"))).toBe(false);
  });
});

const TRANSCRIPT_COLUMN = 'className={cn("flex w-full flex-col gap-3 px-5", CHAT_COLUMN_CLASS)}';
const COMPOSER_COLUMN = 'ref={composerDockRef} className={cn("relative z-[2] w-full shrink-0", CHAT_COLUMN_CLASS)}';

describe("failed tool chip", () => {
  const chip = chatView.slice(chatView.indexOf("function ActivityChip"), chatView.indexOf("function ScreenFrame"));

  it("reads as a stalled step, not an alarm", () => {
    expect(chip).toContain('failed ? "text-warning" : "text-ink-secondary"');
    expect(chip).not.toMatch(/failed \? "text-danger"/);
    expect(chip).toContain("<X size={13} strokeWidth={1.5} />");
  });

  it("explains itself in plain words on hover", () => {
    expect(chip).toContain('title={failed ? t("chat.stepDidNotComplete") : undefined}');
  });
});

/** The class list a JSX block resolves to, as tokens: substring matching reads
 *  `right-full` as `right-0`'s cousin and misses the difference that matters. */
function classTokens(markup: string): Set<string> {
  return new Set(markup.match(/className="([^"]+)"/)?.[1].split(/\s+/) ?? []);
}

describe("assistant message action bar", () => {
  const bubbleFn = chatView.slice(chatView.indexOf("function Bubble("), chatView.indexOf("function ScreenFrame"));
  const botRow = classTokens(bubbleFn.split("data-message-hover-actions").at(-1) ?? "");

  it("docks under the message instead of floating mid-scroll", () => {
    expect(botRow.has("absolute")).toBe(true);
    expect(botRow.has("bottom-0")).toBe(true);
    expect(bubbleFn).not.toContain("top-1/2 left-full z-20 ml-0.5 flex -translate-y-1/2");
  });

  // right-0 against a w-fit bubble grows the row leftwards, so a short bot
  // message pushes its leading controls out under the scroller's overflow-x-hidden
  it("anchors to the bubble's left edge, the side a bot message has room on", () => {
    expect(botRow.has("left-0")).toBe(true);
    expect(botRow.has("right-0")).toBe(false);
  });

  it("reserves its band so it cannot cover the timestamp or the reaction chips", () => {
    expect(bubbleFn).toContain('cn("relative w-fit max-w-[min(42rem,78%)]", !user && "pb-8")');
    expect(bubbleFn).not.toContain("top-full");
  });
});

describe("message timestamp tooltip", () => {
  const label = chatView.slice(chatView.indexOf("function TimestampLabel"), chatView.indexOf("function Bubble("));

  it("stops relying on the native title tooltip for the full timestamp", () => {
    expect(chatView).not.toContain("new Date(message.at).toLocaleString()");
  });

  it("renders a soft-cornered custom tooltip with the full timestamp", () => {
    expect(label).toMatch(/rounded-md border border-hairline\/40 bg-panel[^"]*shadow-sm/);
    expect(label).toContain("{full}");
  });

  it("formats in the app locale and only when the message time changes", () => {
    expect(label).toContain("const tag = localeTag(locale);");
    expect(label).toContain("useMemo(() => formatDateTime(at, tag), [at, tag])");
    // the short time sits directly under the full date; one locale between them
    expect(label).toContain("{formatTime(at, tag)}");
  });

  it("portals to the body so neither the scroller nor the live region holds it", () => {
    expect(label).toContain("createPortal(");
    expect(label).toContain("document.body,");
    expect(label).toContain("fixed z-40");
    expect(label).toContain("viewportWidth: window.innerWidth,");
    expect(label).toContain("viewportHeight: window.innerHeight,");
  });

  it("is reachable by keyboard and describes the label only once placed", () => {
    expect(label).toContain("aria-describedby={box ? tipId : undefined}");
    expect(label).toContain("onFocus={() => setOpen(true)}");
    expect(label).toContain("onBlur={() => setOpen(false)}");
    expect(label).toContain("group-focus-within:opacity-100");
  });
});

describe("chat column width", () => {
  it("shares a centered 960px column across ChatView transcript and composer", () => {
    expect(chatView).toContain(TRANSCRIPT_COLUMN);
    expect(chatView).toContain(COMPOSER_COLUMN);
    // the scroller's own marker, not the selector the tooltip looks it up with
    const column = chatView.indexOf(TRANSCRIPT_COLUMN);
    const scroller = chatView.slice(chatView.lastIndexOf("data-orbit-transcript", column), column);
    expect(scroller).toContain("[overflow-anchor:none]");
    expect(scroller).not.toContain("px-5");
  });

  it("shares the same centered column in GroupView", () => {
    expect(groupView).toContain(TRANSCRIPT_COLUMN);
    expect(groupView).toContain(COMPOSER_COLUMN);
    const setup = groupView.slice(groupView.indexOf("setupPending ?"), groupView.indexOf(TRANSCRIPT_COLUMN));
    expect(setup).not.toContain("CHAT_COLUMN_CLASS");
    expect(setup).toContain("px-5");
    expect(setup).toContain("TRANSCRIPT_GAP");
  });

  it("keeps the column token at 960px centered without baking in gutters", () => {
    const token = readFileSync(join(here, "chat-column.ts"), "utf8");
    expect(token).toContain("max-w-[960px]");
    expect(token).toContain("mx-auto");
    expect(token).not.toMatch(/CHAT_COLUMN_CLASS = "[^"]*px-5/);
    expect(token).not.toMatch(/CHAT_COLUMN_CLASS = "[^"]*w-full/);
  });
});
