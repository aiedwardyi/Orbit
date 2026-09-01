import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { detectLocale, readPreference, resolveLocale, translate, uiFontStack, writePreference, en, ko } from "./i18n.mjs";

describe("packaged locale", () => {
  it("maps Korean OS tags onto Korean packaged copy", () => {
    expect(detectLocale("ko-KR")).toBe("ko");
    expect(resolveLocale("system", "ko")).toBe("ko");
    expect(resolveLocale("en", "ko-KR")).toBe("en");
  });

  it("persists an explicit choice in userData", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-locale-"));
    try {
      expect(readPreference(dir)).toBe("system");
      writePreference(dir, "ko");
      expect(readPreference(dir)).toBe("ko");
      expect(JSON.parse(readFileSync(join(dir, "locale-preference.json"), "utf8"))).toEqual({
        preference: "ko",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has matching English and Korean packaged phrases", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    expect(translate("ko", "packaged.bootTitle")).not.toBe(translate("en", "packaged.bootTitle"));
  });

  it("includes Malgun Gothic in the packaged fallback stack", () => {
    expect(uiFontStack()).toContain("Malgun Gothic");
  });
});

describe("desktop viewer copy", () => {
  it("paints the error page from packaged keys and includes Malgun Gothic", () => {
    const main = readFileSync(join(import.meta.dirname, "main.mjs"), "utf8");
    expect(main).toContain('nativeText("packaged.desktopUnavailable")');
    expect(main).toContain('nativeText("packaged.liveDesktopFailed")');
    expect(main).toContain('nativeText("packaged.openInBrowser")');
    expect(main).toContain('nativeText("packaged.liveDesktop")');
    expect(main).toMatch(/desktopViewerErrorPage[\s\S]*uiFontStack\(\)/);
  });
});
