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
const createBotSheet = readFileSync(join(here, "../components/CreateBotSheet.tsx"), "utf8");

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

describe("sidebar create channel and bot/room chrome", () => {
  it("keeps Create Channel, Duplicate, Archive, Delete, and Move to context as complete EN+KO phrases", () => {
    expect(en["chrome.createChannel"]).toBe("Create Channel");
    expect(en["chrome.createChannelOne"]).toBe("Create Channel · {count} bot");
    expect(en["chrome.createChannelMany"]).toBe("Create Channel · {count} bots");
    expect(ko["chrome.createChannel"]).toBe("채널 만들기");
    expect(ko["chrome.createChannelOne"]).toBe("채널 만들기 · 봇 {count}개");
    expect(ko["chrome.createChannelMany"]).toBe("채널 만들기 · 봇 {count}개");
    expect(ko["chrome.createChannelOne"]).not.toMatch(/Create Channel|\bbot\b|\bbots\b/i);
    expect(ko["chrome.createChannelMany"]).not.toMatch(/Create Channel|\bbot\b|\bbots\b/i);
    expect(en["chrome.duplicate"]).toBe("Duplicate");
    expect(ko["chrome.duplicate"]).toBe("복제");
    expect(ko["chrome.duplicate"]).not.toMatch(/Duplicate/i);
    expect(en["chrome.archive"]).toBe("Archive");
    expect(ko["chrome.archive"]).toBe("보관");
    expect(ko["chrome.archive"]).not.toMatch(/Archive/i);
    expect(en["chrome.delete"]).toBe("Delete");
    expect(ko["chrome.delete"]).toBe("삭제");
    expect(en["chrome.chooseEngineFirst"]).toBe("Choose a Claude or ACP engine first");
    expect(ko["chrome.chooseEngineFirst"]).toBe("먼저 Claude 또는 ACP 엔진을 선택하세요");
    expect(ko["chrome.chooseEngineFirst"]).not.toMatch(/Choose a Claude/i);
    expect(en["chrome.moveToContext"]).toBe("Move to context");
    expect(ko["chrome.moveToContext"]).toBe("맥락으로 이동");
    expect(ko["chrome.moveToContext"]).not.toMatch(/Move to context/i);
    expect(en["chrome.deleteChannel"]).toBe("Delete Channel");
    expect(ko["chrome.deleteChannel"]).toBe("채널 삭제");
    expect(ko["chrome.deleteChannel"]).not.toMatch(/Delete Channel/i);
  });

  it("wires those phrases into Sidebar instead of hardcoded English", () => {
    expect(sidebar).toContain('t("chrome.createChannel")');
    expect(sidebar).toContain('"chrome.createChannelOne"');
    expect(sidebar).toContain('"chrome.createChannelMany"');
    expect(sidebar).toContain('picked.size === 1 ? "chrome.createChannelOne" : "chrome.createChannelMany"');
    expect(sidebar).toContain('t("chrome.duplicate")');
    expect(sidebar).toContain('t("chrome.archive")');
    expect(sidebar).toContain('t("chrome.delete")');
    expect(sidebar).toContain('t("chrome.chooseEngineFirst")');
    expect(sidebar).toContain('t("chrome.moveToContext")');
    expect(sidebar).toContain('t("chrome.deleteChannel")');
    expect(sidebar).not.toMatch(/Create Channel\{picked\.size/);
    expect(sidebar).not.toMatch(/picked\.size === 1 \? "bot" : "bots"/);
    expect(sidebar).not.toMatch(/,\s*"Duplicate",/);
    expect(sidebar).not.toMatch(/,\s*"Archive",/);
    expect(sidebar).not.toMatch(/,\s*"Delete",/);
    expect(sidebar).not.toMatch(/Choose a Claude or ACP engine first/);
    expect(sidebar).not.toMatch(/Move to context/);
    expect(sidebar).not.toMatch(/Delete Channel/);
    expect(sidebar).toContain('t("chrome.you")');
    expect(sidebar).not.toMatch(/\|\| "You"}/);
  });
});

describe("create-bot sheet", () => {
  it("keeps the job-first onboarding question as complete EN+KO phrases", () => {
    expect(en["createBot.title"]).toBe("What should this bot handle?");
    expect(ko["createBot.title"]).toBe("이 봇은 어떤 일을 맡을까요?");
    expect(ko["createBot.title"]).not.toMatch(/What should this bot handle/i);
    expect(en["createBot.help"]).toContain("ongoing job");
    expect(ko["createBot.help"]).not.toMatch(/Describe one ongoing job/i);
    expect(ko["createBot.help"]).not.toMatch(/Start chatting/i);
    expect(en["createBot.jobLabel"]).toBe("Bot job");
    expect(ko["createBot.jobLabel"]).toBe("봇이 맡을 일");
    expect(en["createBot.placeholder"]).toContain("For example");
    expect(ko["createBot.placeholder"]).toContain("예:");
    expect(ko["createBot.placeholder"]).not.toMatch(/Keep a weekly competitor brief/i);
    expect(en["createBot.cancel"]).toBe("Cancel");
    expect(ko["createBot.cancel"]).toBe("취소");
    expect(en["createBot.start"]).toBe("Start chatting");
    expect(ko["createBot.start"]).toBe("대화 시작");
    expect(ko["createBot.start"]).not.toMatch(/Start chatting/i);
    expect(en["chrome.you"]).toBe("You");
    expect(ko["chrome.you"]).toBe("나");
  });

  it("wires those phrases and never sends the user's job text through t()", () => {
    expect(createBotSheet).toContain('t("createBot.title")');
    expect(createBotSheet).toContain('t("createBot.help")');
    expect(createBotSheet).toContain('t("createBot.jobLabel")');
    expect(createBotSheet).toContain('t("createBot.placeholder")');
    expect(createBotSheet).toContain('t("createBot.cancel")');
    expect(createBotSheet).toContain('t("createBot.start")');
    expect(createBotSheet).not.toMatch(/What should this bot handle\?/);
    expect(createBotSheet).not.toMatch(/Describe one ongoing job/);
    expect(createBotSheet).not.toMatch(/Keep a weekly competitor brief/);
    expect(createBotSheet).not.toMatch(/Start chatting/);
    expect(createBotSheet).not.toMatch(/>Bot job</);
    expect(createBotSheet).not.toMatch(/t\(job/);
    expect(createBotSheet).not.toMatch(/t\(normalized/);
  });
});
