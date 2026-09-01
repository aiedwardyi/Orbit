import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { catalogs, en, ko, type MessageKey } from "./i18n-catalog";
import {
  activeLocale,
  applyLocale,
  detectLocale,
  localeTag,
  persistPreference,
  readPreference,
  resolveLocale,
  translate,
} from "./i18n";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

afterEach(() => {
  applyLocale("en");
});

describe("locale detection", () => {
  it("treats Korean OS tags as Korean and everything else as English", () => {
    expect(detectLocale("ko")).toBe("ko");
    expect(detectLocale("ko-KR")).toBe("ko");
    expect(detectLocale("ko_kr")).toBe("ko");
    expect(detectLocale("kor")).toBe("ko");
    expect(detectLocale("en")).toBe("en");
    expect(detectLocale("en-US")).toBe("en");
    expect(detectLocale("ja")).toBe("en");
    expect(detectLocale("zh-CN")).toBe("en");
    expect(detectLocale("")).toBe("en");
    expect(detectLocale(undefined)).toBe("en");
  });

  it("follows the OS until an explicit choice is stored", () => {
    expect(resolveLocale("system", "ko-KR")).toBe("ko");
    expect(resolveLocale("system", "en-GB")).toBe("en");
    expect(resolveLocale("en", "ko-KR")).toBe("en");
    expect(resolveLocale("ko", "en-US")).toBe("ko");
  });
});

describe("catalogs", () => {
  it("has the same complete-phrase keys in English and Korean", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    // SAFETY: catalog keys are MessageKey; Object.keys widens to string[].
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(en[key].length).toBeGreaterThan(0);
      expect(ko[key].length).toBeGreaterThan(0);
    }
  });

  it("keeps placeholders inside complete phrases, never as glue", () => {
    // SAFETY: catalog keys are MessageKey; Object.keys widens to string[].
    const keys = Object.keys(en) as MessageKey[];
    for (const key of keys) {
      const names = [...en[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      const koNames = [...ko[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      expect(koNames).toEqual(names);
    }
  });

  it("uses Korean word order instead of English fragments", () => {
    expect(ko["composer.placeholder"].startsWith("{name}")).toBe(true);
    expect(ko["composer.placeholder"]).not.toContain("Message {name}");
    expect(ko["room.setupTitle"].startsWith("{name}")).toBe(true);
    expect(ko["chat.conversationAria"].includes("{name}")).toBe(true);
    expect(ko["chrome.botWorking"].startsWith("{name}")).toBe(true);
  });
});

describe("translate", () => {
  it("fills named placeholders without rearranging caller-supplied content", () => {
    const userName = "hello-bot";
    expect(translate("ko", "composer.placeholder", { name: userName })).toContain(userName);
    expect(translate("en", "composer.placeholder", { name: userName })).toBe("Message hello-bot");
    expect(translate("ko", "chrome.youPrefix", { text: "keep this transcript" })).toContain("keep this transcript");
  });

  it("does not treat user or bot text as a message key", () => {
    expect(Object.hasOwn(catalogs.en, "keep this transcript")).toBe(false);
    expect(Object.hasOwn(catalogs.ko, "keep this transcript")).toBe(false);
  });
});

describe("preference persistence", () => {
  it("defaults to following the OS when nothing is stored", () => {
    expect(readPreference()).toBe("system");
  });

  it("remembers an explicit English or Korean choice", () => {
    persistPreference("ko");
    expect(activeLocale()).toBe("ko");
    persistPreference("en");
    expect(activeLocale()).toBe("en");
  });
});

describe("fonts", () => {
  it("puts Malgun Gothic in the UI sans fallback stack without a remote font URL", () => {
    expect(css).toMatch(/--font-sans:[\s\S]*"Malgun Gothic"/);
    expect(css).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });
});

describe("html locale", () => {
  it("stamps a BCP-47 lang tag for the active locale", () => {
    expect(localeTag("ko")).toBe("ko");
    expect(localeTag("en")).toBe("en");
  });
});
