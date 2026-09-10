import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

const sources = {
  store: readFileSync(join(root, "server/store.ts"), "utf8"),
  index: readFileSync(join(root, "server/index.ts"), "utf8"),
  createBotSheet: readFileSync(join(root, "src/components/CreateBotSheet.tsx"), "utf8"),
  sidebar: readFileSync(join(root, "src/components/Sidebar.tsx"), "utf8"),
  clientStore: readFileSync(join(root, "src/state/store.tsx"), "utf8"),
  avatarCard: readFileSync(join(root, "src/components/BotProfileAvatarCard.tsx"), "utf8"),
} as const;

describe("new bot mascot creation paths", () => {
  it("stores white squircle at every new-bot write", () => {
    expect(sources.store).toMatch(/color:\s*profile\.color \?\? ["']white["']/);
    expect(sources.store).toContain("mascotStyle: DEFAULT_MASCOT_STYLE");

    expect(sources.index).toContain('color: "white"');
    expect(sources.index).toContain('mascotStyle: "squircle"');
    expect(sources.index).toContain('imported.mascotStyle ?? "squircle"');

    expect(sources.createBotSheet).toContain("DEFAULT_MAUS_COLOR");
    expect(sources.createBotSheet).toContain("DEFAULT_MASCOT_STYLE");
    expect(sources.sidebar).toContain("DEFAULT_MAUS_COLOR");
    expect(sources.sidebar).toContain("DEFAULT_MASCOT_STYLE");
  });

  it("copies the source mascot on duplicate and leaves Reset mascot on the defaults", () => {
    expect(sources.clientStore).toContain("color: source.color");
    expect(sources.clientStore).toContain("mascotStyle: source.mascotStyle");
    expect(sources.avatarCard).toContain("color: DEFAULT_MAUS_COLOR");
    expect(sources.avatarCard).toContain("mascotStyle: DEFAULT_MASCOT_STYLE");
  });
});
