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

describe("assistant message action bar", () => {
  const bubbleFn = chatView.slice(chatView.indexOf("function Bubble("), chatView.indexOf("function ScreenFrame"));

  it("docks at the bottom right of the message instead of floating mid-scroll", () => {
    expect(bubbleFn).toContain("top-full right-0 z-20 mt-1");
    expect(bubbleFn).not.toContain("top-1/2 left-full z-20 ml-0.5 flex -translate-y-1/2");
  });
});

describe("message timestamp tooltip", () => {
  const bubble = chatView.slice(chatView.indexOf("function Bubble("), chatView.indexOf("function ScreenFrame"));

  it("stops relying on the native title tooltip for the full timestamp", () => {
    expect(bubble).not.toContain("title={new Date(message.at).toLocaleString()}");
  });

  it("renders a soft-cornered custom tooltip with the full timestamp", () => {
    expect(bubble).toMatch(/rounded-md border border-hairline\/40 bg-panel[^"]*shadow-sm/);
    expect(bubble).toContain("{fullTimestamp}");
  });
});

describe("chat column width", () => {
  it("shares a centered 960px column across ChatView transcript and composer", () => {
    expect(chatView).toContain(TRANSCRIPT_COLUMN);
    expect(chatView).toContain(COMPOSER_COLUMN);
    const scroller = chatView.slice(
      chatView.indexOf("data-orbit-transcript"),
      chatView.indexOf(TRANSCRIPT_COLUMN),
    );
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
