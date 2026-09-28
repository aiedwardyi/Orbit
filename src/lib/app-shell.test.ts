import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "src/styles.css"), "utf8");

describe("home-screen app shell", () => {
  it("links a valid standalone manifest whose icons exist", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.json" />');
    const manifest = JSON.parse(readFileSync(join(root, "public/manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "Orbit", start_url: "/", display: "standalone" });
    expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(["192x192", "512x512", "512x512"]);
    expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) expect(existsSync(join(root, "public", icon.src))).toBe(true);
  });

  it("preloads the webfont of every skin whose UI text uses one", () => {
    const bundled = new Map(
      [...css.matchAll(/@font-face \{\s*font-family: "([^"]+)";\s*src: url\("\/fonts\/([^"]+)-Variable\.woff2"\)/g)].map((m) => [m[1], m[2]]),
    );
    const expected: Record<string, string> = {};
    for (const [, skin, family] of css.matchAll(/\[data-skin="([\w-]+)"\] \{[^}]*?--font-sans: "([^"]+)"/g)) {
      const file = bundled.get(family);
      if (file) expected[skin] = file;
    }
    const preloads = JSON.parse(`{${html.match(/var font = \{([^}]*)\}/)![1].replace(/(\w+):/g, '"$1":')}}`);
    expect(preloads).toEqual(expected);
    for (const file of Object.values(preloads)) expect(existsSync(join(root, `public/fonts/${file}-Variable.woff2`))).toBe(true);
  });
});
