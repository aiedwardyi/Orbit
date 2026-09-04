import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { botAvatarProfile } from "../../shared/bot-avatar";

const here = dirname(fileURLToPath(import.meta.url));

const sources = {
  "GroupView.tsx": readFileSync(join(here, "GroupView.tsx"), "utf8"),
  "TeamMapPage.tsx": readFileSync(join(here, "TeamMapPage.tsx"), "utf8"),
  "ChatView.tsx": readFileSync(join(here, "ChatView.tsx"), "utf8"),
  "Avatar.tsx": readFileSync(join(here, "Avatar.tsx"), "utf8"),
  "BotProfileAvatarCard.tsx": readFileSync(join(here, "BotProfileAvatarCard.tsx"), "utf8"),
  "store.tsx": readFileSync(join(here, "../state/store.tsx"), "utf8"),
} as const;

const botAvatarFloors = {
  "GroupView.tsx": 6,
  "TeamMapPage.tsx": 1,
  "ChatView.tsx": 4,
} as const;

describe("channel avatar renderer", () => {
  for (const file of Object.keys(botAvatarFloors) as Array<keyof typeof botAvatarFloors>) {
    it(`${file} uses BotAvatar and never mounts MausAvatar directly`, () => {
      const source = sources[file];
      const renders = source.match(/<BotAvatar/g)?.length ?? 0;
      expect(renders).toBeGreaterThanOrEqual(botAvatarFloors[file]);
      expect(source).not.toContain("<MausAvatar");
    });
  }
});

describe("bot avatar profile", () => {
  it("keeps a valid image for a non-mascot crop", () => {
    expect(
      botAvatarProfile({
        avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp",
        avatarCrop: "circle",
      }),
    ).toEqual({
      avatarCrop: "circle",
      avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp",
      mascotStyle: "peach",
    });
  });
});

describe("cute mascot renderer", () => {
  it("does not wrap the Cursor arrow-head path for default bot avatars", () => {
    expect(sources["Avatar.tsx"]).not.toContain("CursorAvatar");
    expect(sources["Avatar.tsx"]).toContain("mascotDataUrl");
    expect(sources["Avatar.tsx"]).toContain("mascotStyle");
  });

  it("offers styles A–D on the avatar editor instead of expression swatches", () => {
    expect(sources["BotProfileAvatarCard.tsx"]).toContain("MASCOT_STYLES");
    expect(sources["BotProfileAvatarCard.tsx"]).toContain("mascotStyle");
    expect(sources["BotProfileAvatarCard.tsx"]).toContain("resolvedStyle");
    expect(sources["BotProfileAvatarCard.tsx"]).not.toContain("PICKABLE_STATES");
  });

  it("types Bot.mascotStyle as the style union and does not animate style-only edits", () => {
    expect(sources["store.tsx"]).toContain("mascotStyle?: MascotStyle | null");
    expect(sources["store.tsx"]).not.toContain('hasOwnProperty.call(action.patch, "mascotStyle")');
    expect(sources["Avatar.tsx"]).toContain("useMemo(() => mascotDataUrl(style, color), [style, color])");
  });
});
