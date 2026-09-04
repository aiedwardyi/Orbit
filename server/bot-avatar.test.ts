import { describe, expect, it } from "vitest";

import {
  botAvatarProfile,
  botAvatarCropSchema,
  botAvatarUrlFromStoredPath,
  botAvatarUrlSchema,
  DEFAULT_MASCOT_STYLE,
  MASCOT_STYLE_ASSETS,
  MASCOT_STYLES,
  mascotStyleFromColor,
  mascotStyleSchema,
  resolveMascotStyle,
} from "../shared/bot-avatar.ts";

describe("bot avatar profile schema", () => {
  it("accepts the four supported display shapes", () => {
    for (const crop of ["mascot", "circle", "rounded", "square"]) {
      expect(botAvatarCropSchema.parse(crop)).toBe(crop);
    }
    expect(botAvatarCropSchema.safeParse("hexagon").success).toBe(false);
  });

  it("only accepts app-owned raster attachments", () => {
    expect(botAvatarUrlSchema.parse("/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp"))
      .toContain("/api/attachments/");
    for (const value of [
      "https://tracker.example/avatar.png",
      "/api/attachments/avatar.svg",
      "/api/attachments/../../config.json",
      "data:image/png;base64,abc",
    ]) {
      expect(botAvatarUrlSchema.safeParse(value).success).toBe(false);
    }
  });

  it("turns a saved attachment path into a safe serving URL", () => {
    expect(botAvatarUrlFromStoredPath("/tmp/attachments/abc-123.png"))
      .toBe("/api/attachments/abc-123.png");
    expect(botAvatarUrlFromStoredPath("C:\\data\\attachments\\abc-123.jpg"))
      .toBe("/api/attachments/abc-123.jpg");
    expect(botAvatarUrlFromStoredPath("/tmp/attachments/avatar.svg")).toBeNull();
  });

  it("falls back safely for malformed persisted data", () => {
    expect(botAvatarProfile({ avatarUrl: "https://example.test/pixel.png", avatarCrop: "round" }))
      .toEqual({ avatarCrop: "mascot", mascotStyle: DEFAULT_MASCOT_STYLE });
  });
});

describe("mascot style ids", () => {
  it("names the four approved static styles", () => {
    expect(MASCOT_STYLES).toEqual(["peach", "teal", "lavender", "coral"]);
    for (const style of MASCOT_STYLES) {
      expect(mascotStyleSchema.parse(style)).toBe(style);
      expect(MASCOT_STYLE_ASSETS[style]).toMatch(new RegExp(`${style}\\.svg$`));
    }
    expect(mascotStyleSchema.safeParse("arrow-head").success).toBe(false);
    expect(mascotStyleSchema.safeParse("cursor").success).toBe(false);
  });

  it("maps existing arrow-head colors onto a cute style without rewriting the profile", () => {
    expect(mascotStyleFromColor("red")).toBe("peach");
    expect(mascotStyleFromColor("orange")).toBe("peach");
    expect(mascotStyleFromColor("yellow")).toBe("peach");
    expect(mascotStyleFromColor("green")).toBe("teal");
    expect(mascotStyleFromColor("teal")).toBe("teal");
    expect(mascotStyleFromColor("cyan")).toBe("teal");
    expect(mascotStyleFromColor("blue")).toBe("lavender");
    expect(mascotStyleFromColor("purple")).toBe("lavender");
    expect(mascotStyleFromColor("pink")).toBe("coral");
    expect(mascotStyleFromColor("coral")).toBe("coral");
    expect(mascotStyleFromColor("not-a-color")).toBe("peach");
    expect(mascotStyleFromColor(undefined)).toBe("peach");
  });

  it("keeps an explicit style and color-maps only when the stored id is missing or junk", () => {
    expect(resolveMascotStyle("lavender", "red")).toBe("lavender");
    expect(resolveMascotStyle(undefined, "teal")).toBe("teal");
    expect(resolveMascotStyle("triangle", "purple")).toBe("lavender");
    expect(resolveMascotStyle("__proto__", "green")).toBe("teal");
  });

  it("includes the resolved style on a runtime-safe avatar profile", () => {
    expect(
      botAvatarProfile({
        avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp",
        avatarCrop: "circle",
        mascotStyle: "teal",
        color: "red",
      }),
    ).toEqual({
      avatarCrop: "circle",
      avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp",
      mascotStyle: "teal",
    });
    expect(botAvatarProfile({ color: "purple" })).toEqual({
      avatarCrop: "mascot",
      mascotStyle: "lavender",
    });
  });
});
