import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { webManifestForUserAgent } from "./web-manifest.ts";

const manifest = JSON.parse(readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"));
const samsungAndroid = "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
const chromeAndroid = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36";

describe("webManifestForUserAgent", () => {
  it("removes maskable icons for Samsung Internet on Android", () => {
    const result = webManifestForUserAgent(samsungAndroid, manifest);
    expect((result.icons ?? []).every((icon) => !icon.purpose?.split(/\s+/).includes("maskable"))).toBe(true);
    expect((result.icons ?? []).map((icon) => icon.src)).toEqual([
      "/app-icon-192.png?v=2",
      "/app-icon-512.png?v=2",
    ]);
  });

  it("keeps the manifest unchanged for Chrome on Android", () => {
    expect(webManifestForUserAgent(chromeAndroid, manifest)).toBe(manifest);
  });

  it("keeps the manifest unchanged when the user agent is missing", () => {
    expect(webManifestForUserAgent(undefined, manifest)).toBe(manifest);
  });
});
