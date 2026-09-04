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
