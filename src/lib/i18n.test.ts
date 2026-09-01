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

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../styles.css"), "utf8");
const updateBanner = readFileSync(join(here, "../components/UpdateBanner.tsx"), "utf8");
const chatView = readFileSync(join(here, "../components/ChatView.tsx"), "utf8");
const sidebar = readFileSync(join(here, "../components/Sidebar.tsx"), "utf8");

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

describe("complete phrases", () => {
  it("keeps Korean room composer placeholders as complete phrases, not English fragments", () => {
    expect(ko["composer.roomEveryone"]).not.toMatch(/everyone responds|Message \{name\}/i);
    expect(ko["composer.roomMentions"]).not.toMatch(/bring a bot in|Message \{name\}/i);
    expect(ko["composer.roomLead"]).not.toMatch(/responds$|Message \{name\}/i);
    expect(ko["composer.roomDm"]).not.toMatch(/continue the conversation|Message \{name\}/i);
    expect(ko["composer.roomEveryone"]).toContain("{name}");
    expect(ko["composer.roomLead"]).toContain("{lead}");
  });

  it("does not append an English bot-maintained fragment", () => {
    expect(en["chat.savedJustNowBot"]).toContain("bot-maintained");
    expect(ko["chat.savedJustNowBot"]).not.toMatch(/bot-maintained/i);
    expect(ko["chat.savedJustNowBot"]).toContain("봇이 유지");
  });

  it("does not glue an ellipsis onto room.choose", () => {
    expect(en["room.chooseEllipsis"]).toBe("Choose…");
    expect(ko["room.chooseEllipsis"]).toBe("선택…");
    expect(ko["room.choose"]).not.toContain("…");
  });
});

describe("remaining P1 surfaces", () => {
  it("keeps Stop, update banner, and sidebar menu copy as complete EN+KO phrases", () => {
    expect(en["composer.stop"]).toBe("Stop");
    expect(ko["composer.stop"]).toBe("중지");
    expect(en["update.available"]).toContain("{version}");
    expect(ko["update.available"]).toContain("{version}");
    expect(ko["update.available"]).not.toMatch(/is available/i);
    expect(en["update.later"]).toBe("Later");
    expect(ko["update.later"]).toBe("나중에");
    expect(en["chrome.newChannel"]).toBe("New Channel");
    expect(ko["chrome.newChannel"]).toBe("새 채널");
    expect(ko["chrome.newChannel"]).not.toMatch(/New Channel/i);
    expect(ko["chrome.createBotFirst"]).not.toMatch(/Create a bot first/i);
    expect(ko["chrome.chooseAnotherChief"]).not.toMatch(/Chief of Staff/i);
  });

  it("wires those phrases into UpdateBanner, the Stop chip, and the sidebar", () => {
    expect(updateBanner).toContain('t("update.available"');
    expect(updateBanner).toContain('t("update.downloadingGeneric")');
    expect(updateBanner).toContain('t("update.ready"');
    expect(updateBanner).toContain('t("update.checkFailed")');
    expect(updateBanner).toContain('t("update.newerReady")');
    expect(updateBanner).toContain('t("update.restartToFinish")');
    expect(updateBanner).toContain('t("update.willReopen")');
    expect(updateBanner).toContain('t("update.genericError")');
    expect(updateBanner).toContain('t("update.nonePublished")');
    expect(updateBanner).toContain('t("update.unreachable")');
    expect(updateBanner).toContain('t("update.dismiss")');
    expect(updateBanner).toContain('t("update.later")');
    expect(updateBanner).toContain('t("update.download")');
    expect(updateBanner).not.toMatch(/>Later</);
    expect(chatView).toContain('t("composer.stop")');
    expect(chatView).not.toMatch(/<span className="@max-4xl\/chathead:hidden">Stop<\/span>/);
    expect(sidebar).toContain('t("chrome.newChannel")');
    expect(sidebar).toContain('t("chrome.createBotFirst")');
    expect(sidebar).toContain('t("chrome.chooseAnotherChief")');
    expect(sidebar).toContain('t("chrome.teamMap")');
    expect(sidebar).not.toMatch(/aria-label=\{density === "icons" \? "Team map"/);
  });
});
