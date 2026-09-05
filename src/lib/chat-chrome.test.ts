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

describe("chat column width", () => {
  it("shares a centered 960px column across ChatView transcript and composer", () => {
    expect(chatView).toContain("CHAT_COLUMN_CLASS");
    expect(chatView.split("CHAT_COLUMN_CLASS").length - 1).toBeGreaterThanOrEqual(2);
    expect(chatView).toMatch(/flex w-full flex-col gap-3[\s\S]{0,80}CHAT_COLUMN_CLASS/);
    expect(chatView).toMatch(/composerDockRef[\s\S]{0,160}CHAT_COLUMN_CLASS/);
  });

  it("shares the same centered column in GroupView", () => {
    expect(groupView).toContain("CHAT_COLUMN_CLASS");
    expect(groupView.split("CHAT_COLUMN_CLASS").length - 1).toBeGreaterThanOrEqual(2);
    expect(groupView).toMatch(/flex w-full flex-col gap-3[\s\S]{0,80}CHAT_COLUMN_CLASS/);
    expect(groupView).toMatch(/composerDockRef[\s\S]{0,160}CHAT_COLUMN_CLASS/);
  });

  it("keeps the column token at 960px centered", () => {
    const token = readFileSync(join(here, "chat-column.ts"), "utf8");
    expect(token).toContain("max-w-[960px]");
    expect(token).toContain("mx-auto");
  });
});
