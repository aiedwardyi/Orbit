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
const settingsPanel = readFileSync(join(here, "../components/SettingsPanel.tsx"), "utf8");
const createBotSheet = readFileSync(join(here, "../components/CreateBotSheet.tsx"), "utf8");
const engineSetup = readFileSync(join(here, "../components/EngineSetup.tsx"), "utf8");
const approvalCard = readFileSync(join(here, "../components/ApprovalCard.tsx"), "utf8");
const pendingApproval = readFileSync(join(here, "../components/PendingApproval.tsx"), "utf8");
const secretRequestCard = readFileSync(join(here, "../components/SecretRequestCard.tsx"), "utf8");
const modelPicker = readFileSync(join(here, "../components/ModelPicker.tsx"), "utf8");
const taskPicker = readFileSync(join(here, "../components/TaskPicker.tsx"), "utf8");
const renameTitle = readFileSync(join(here, "../components/RenameTitle.tsx"), "utf8");
const enginesSettings = readFileSync(join(here, "../components/EnginesSettings.tsx"), "utf8");
const searchResults = readFileSync(join(here, "../components/SearchResults.tsx"), "utf8");
const manageMembers = readFileSync(join(here, "../components/ManageMembersPanel.tsx"), "utf8");
const usageSection = readFileSync(join(here, "../components/UsageSection.tsx"), "utf8");
const planUsageBar = readFileSync(join(here, "../components/PlanUsageBar.tsx"), "utf8");
const chatPlanMeters = readFileSync(join(here, "../components/ChatPlanMeters.tsx"), "utf8");
const composer = readFileSync(join(here, "../components/Composer.tsx"), "utf8");
const routinesPage = readFileSync(join(here, "../components/RoutinesPage.tsx"), "utf8");
const noEngines = readFileSync(join(here, "../components/NoEngines.tsx"), "utf8");
const onboarding = readFileSync(join(here, "../components/Onboarding.tsx"), "utf8");

function splitTwoSentences(text: string): { cli: string; key: string } {
  const dotIdx = text.indexOf(". ");
  expect(dotIdx).toBeGreaterThan(-1);
  expect(text.indexOf(". ", dotIdx + 1)).toBe(-1);
  return { cli: text.slice(0, dotIdx + 1), key: text.slice(dotIdx + 2) };
}

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

  it("calls the channel folder a shared project folder, not a per-task pin", () => {
    expect(en["room.workingFolder"]).toBe("Shared project folder");
    expect(ko["room.workingFolder"]).toBe("공유 프로젝트 폴더");
    expect(en["room.workingFolderHelp"]).toMatch(/All bots in this channel/);
    expect(ko["room.workingFolderHelp"]).not.toMatch(/Where room members/i);
    expect(en["room.fixedFolder"]).not.toMatch(/task/i);
    expect(ko["room.fixedFolder"]).not.toMatch(/새 작업/);
    expect(en["room.chooseSharedFolder"]).toBe("Choose a shared folder");
    expect(ko["room.chooseSharedFolder"]).toBe("공유 폴더를 선택하세요");
    expect(en["room.projectFolderChip"]).toBe("Project folder");
    expect(ko["room.projectFolderChip"]).toBe("프로젝트 폴더");
    expect(en["chrome.resizeSidebar"]).toBe("Resize sidebar");
    expect(ko["chrome.resizeSidebar"]).toBe("사이드바 너비 조절");
    expect(en["chrome.sidebarWidthPixels"]).toBe("{width} pixels");
    expect(ko["chrome.sidebarWidthPixels"]).toBe("{width}픽셀");
    expect(translate("en", "chrome.sidebarWidthPixels", { width: 320 })).toBe("320 pixels");
    expect(translate("ko", "chrome.sidebarWidthPixels", { width: 320 })).toBe("320픽셀");
  });
});

describe("Friends Routine naming and one Stop", () => {
  it("uses Routine as the product name, not Tasks & routines", () => {
    expect(en["chrome.routines"]).toBe("Routines");
    expect(ko["chrome.routines"]).toBe("루틴");
    expect(en["chrome.routines"]).not.toMatch(/Task/i);
    expect(ko["chrome.routines"]).not.toMatch(/작업/);
    expect(en["routine.runNow"]).toBe("Run now");
    expect(ko["routine.runNow"]).toBe("지금 실행");
    expect(en["routine.queuing"]).toBe("Queuing this routine…");
    expect(ko["routine.queuing"]).toBe("이 루틴을 대기열에 넣는 중…");
    expect(en["routine.queuedNamed"]).toBe("{name} is queued.");
    expect(ko["routine.queuedNamed"]).toBe("{name} 루틴이 대기 중입니다.");
    expect(en["routine.runningNamed"]).toBe("{name} is running.");
    expect(ko["routine.runningNamed"]).toBe("{name} 루틴이 실행 중입니다.");
    expect(en["routine.waitingNamed"]).toBe("{name} needs your input.");
    expect(ko["routine.waitingNamed"]).toBe("{name} 루틴이 응답을 기다립니다.");
    expect(en["routine.openThread"]).toBe("Open this routine thread");
    expect(ko["routine.openThread"]).toBe("이 루틴 대화 열기");
    expect(en["chat.routineQueuedElsewhere"]).toBe("{name} is queued on this bot.");
    expect(ko["chat.routineQueuedElsewhere"]).toBe("이 봇에서 {name} 루틴이 대기 중입니다.");
    expect(en["chat.routineRunningElsewhere"]).toBe("{name} is running in another thread on this bot.");
    expect(ko["chat.routineRunningElsewhere"]).toBe("이 봇의 다른 대화에서 {name} 루틴이 실행 중입니다.");
    expect(en["chat.routineWaitingElsewhere"]).toBe("{name} is waiting for you in another thread on this bot.");
    expect(ko["chat.routineWaitingElsewhere"]).toBe("이 봇의 다른 대화에서 {name} 루틴이 응답을 기다립니다.");
    expect(en["chat.openRoutineThread"]).toBe("Open that thread");
    expect(ko["chat.openRoutineThread"]).toBe("그 대화 열기");
    expect(en["task.running"]).toBe("Running");
    expect(ko["task.running"]).toBe("실행 중");
    expect(en["routine.pageHelp"]).toBe("A routine starts a fresh conversation on this bot each time it runs.");
    expect(ko["routine.pageHelp"]).toBe("루틴은 실행될 때마다 이 봇에서 새 대화를 시작합니다.");
    expect(translate("en", "chat.routineRunningElsewhere", { name: "keep this name" })).toContain("keep this name");
    expect(translate("ko", "chat.routineRunningElsewhere", { name: "keep this name" })).toContain("keep this name");
    expect(Object.hasOwn(catalogs.en, "keep this name")).toBe(false);
  });

  it("wires Routine copy into the sidebar and calendar, and keeps a single Stop in the composer", () => {
    expect(sidebar).toContain('t("chrome.routines")');
    expect(routinesPage).toContain('t("chrome.routines")');
    expect(routinesPage).toContain('t("routine.pageHelp")');
    expect(routinesPage).toContain('t("routine.runNow")');
    expect(routinesPage).toContain('t("routine.openThread")');
    expect(routinesPage).not.toMatch(/Tasks &amp; routines|Tasks & routines/);
    expect(routinesPage).not.toMatch(/>Run now</);
    expect(routinesPage).not.toMatch(/>Open task</);
    expect(taskPicker).toContain('t("task.running")');
    expect(chatView).toContain('t("chat.routineRunningElsewhere"');
    expect(chatView).toContain('t("chat.openRoutineThread")');
    expect(composer).toContain('t("composer.stop")');
    expect(chatView).not.toContain('t("composer.stop")');
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
    expect(composer).toContain('t("composer.stop")');
    expect(chatView).not.toContain('t("composer.stop")');
    expect(chatView).not.toMatch(/type: "interrupt"/);
    expect(sidebar).toContain('t("chrome.newChannel")');
    expect(sidebar).toContain('t("chrome.createBotFirst")');
    expect(sidebar).toContain('t("chrome.chooseAnotherChief")');
    expect(sidebar).toContain('t("chrome.teamMap")');
    expect(sidebar).toContain('t("chrome.resizeSidebar")');
    expect(sidebar).toContain('t("chrome.sidebarWidthPixels", { width: sidebarDisplayWidth })');
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
    expect(en["chrome.cannotContactTeammates"]).toBe("This engine cannot contact teammates yet");
    expect(ko["chrome.cannotContactTeammates"]).toBe("이 엔진은 아직 팀원에게 연락할 수 없습니다");
    expect(ko["chrome.cannotContactTeammates"]).not.toMatch(/cannot contact/i);
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
    expect(sidebar).toContain('t("chrome.cannotContactTeammates")');
    expect(sidebar).toContain('t("chrome.moveToContext")');
    expect(sidebar).toContain('t("chrome.deleteChannel")');
    expect(sidebar).not.toMatch(/Create Channel\{picked\.size/);
    expect(sidebar).not.toMatch(/picked\.size === 1 \? "bot" : "bots"/);
    expect(sidebar).not.toMatch(/,\s*"Duplicate",/);
    expect(sidebar).not.toMatch(/,\s*"Archive",/);
    expect(sidebar).not.toMatch(/,\s*"Delete",/);
    expect(sidebar).not.toMatch(/This engine cannot contact teammates yet/);
    expect(sidebar).not.toMatch(/Move to context/);
    expect(sidebar).not.toMatch(/Delete Channel/);
    expect(sidebar).toContain('t("chrome.you")');
    expect(sidebar).not.toMatch(/\|\| "You"}/);
  });

  it("shares the teammates line with Bot details instead of a second hardcoded copy", () => {
    expect(settingsPanel).toContain('t("chrome.cannotContactTeammates")');
    expect(settingsPanel).not.toMatch(/This engine cannot contact teammates yet/);
    expect(settingsPanel).not.toMatch(/This engine cannot contact other bots/);
  });
});

describe("empty-engine first launch copy", () => {
  it("keeps the Grok-or-Claude connect path as complete EN+KO phrases", () => {
    expect(en["noEngines.title"]).toBe("Connect Grok or Claude");
    expect(ko["noEngines.title"]).toBe("Grok 또는 Claude를 연결하세요");
    expect(ko["noEngines.title"]).not.toMatch(/Connect Grok or Claude/i);
    expect(en["noEngines.body"]).toBe("Your bots need one of these to run. Pick the one you already use.");
    expect(ko["noEngines.body"]).toBe("봇을 쓰려면 둘 중 하나가 필요합니다. 이미 쓰는 쪽을 고르세요.");
    expect(ko["noEngines.body"]).not.toMatch(/Your bots need one of these/i);
    expect(en["noEngines.checkAgain"]).toBe("Check again");
    expect(ko["noEngines.checkAgain"]).toBe("다시 확인");
  });

  it("wires that path into NoEngines and first-run onboarding", () => {
    expect(noEngines).toContain('t("noEngines.title")');
    expect(noEngines).toContain('t("noEngines.body")');
    expect(noEngines).toContain('t("noEngines.checkAgain")');
    expect(noEngines).not.toMatch(/Install an AI engine to get started/);
    expect(onboarding).toContain('t("noEngines.title")');
    expect(onboarding).toContain('t("noEngines.body")');
    expect(onboarding).toContain('t("noEngines.checkAgain")');
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

describe("first-run core path leftovers", () => {
  it("keeps engine setup, approvals, pickers, and rename chrome as complete EN+KO phrases", () => {
    expect(en["engine.signInTo"]).toContain("{name}");
    expect(ko["engine.signInTo"]).toContain("{name}");
    expect(ko["engine.signInTo"]).not.toMatch(/Sign in to/i);
    expect(en["engine.copyCommand"]).toBe("Copy command");
    expect(ko["engine.copyCommand"]).toBe("명령 복사");
    expect(en["approval.wantsNamed"]).toContain("{action}");
    expect(ko["approval.wantsNamed"]).toContain("{action}");
    expect(ko["approval.action.runCommand"]).not.toMatch(/run a command/i);
    expect(en["approval.alwaysAllow"]).toBe("Always allow");
    expect(ko["approval.alwaysAllow"]).toBe("항상 허용");
    expect(en["secret.saveSecurely"]).toBe("Save securely");
    expect(ko["secret.saveSecurely"]).not.toMatch(/Save securely/i);
    expect(en["chrome.add"]).toBe("Add");
    expect(ko["chrome.add"]).toBe("추가");
    expect(en["chrome.removeFromContext"]).toBe("Remove from context");
    expect(ko["chrome.removeFromContext"]).not.toMatch(/Remove from context/i);
    expect(en["task.new"]).toBe("New task");
    expect(ko["task.new"]).toBe("새 작업");
    expect(en["task.matching"]).toContain("{count}");
    expect(ko["task.matching"]).toContain("{count}");
    expect(en["chat.startConversation"]).toContain("Send a message");
    expect(ko["chat.startConversation"]).not.toMatch(/Send a message/i);
    expect(en["model.automatic"]).toBe("Automatic");
    expect(ko["model.automatic"]).toBe("자동");
    expect(en["model.switchEngine"]).toBe("Switch engine");
    expect(ko["model.switchEngine"]).toBe("엔진 바꾸기");
    expect(ko["model.switchEngine"]).not.toMatch(/Switch engine/i);
    expect(en["model.cliVersion"]).toBe("CLI {version}");
    expect(ko["model.cliVersion"]).toBe("CLI 패키지 {version}");
    expect(en["model.pinnedTitle"]).toBe("{engine} · {model}");
    expect(ko["model.pinnedTitle"]).toBe("{engine} · {model}");
    expect(en["model.automaticHelp"]).toContain("when it works");
    expect(en["model.automaticHelp"]).toContain("{name}");
    expect(ko["model.automaticHelp"]).toContain("{name}");
    expect(ko["model.automaticHelp"]).not.toMatch(/when it works/i);
    expect(translate("en", "model.automaticHelp", { name: "Grok 4.6" })).toContain("Grok 4.6");
    expect(en["engine.openConnections"]).toBe("Enter API key");
    expect(ko["engine.openConnections"]).toBe("API 키 입력");
    expect(en["engines.models"]).toBe("Models");
    expect(ko["engines.models"]).toBe("모델");
    expect(en["usage.limits.unavailable"]).toBe("{name} does not report a usage limit.");
    expect(en["usage.limits.pending"]).toBe("Appears after your next {name} message");
    expect(translate("en", "model.cliVersion", { version: "1.0.13" })).toBe("CLI 1.0.13");
    expect(translate("ko", "model.cliVersion", { version: "1.0.13" })).toBe("CLI 패키지 1.0.13");
    expect(en["model.showAll"]).toContain("{count}");
    expect(ko["model.showAll"]).toContain("{count}");
    expect(en["engines.setCli"]).toBe("Set CLI…");
    expect(ko["engines.setCli"]).toBe("CLI 지정…");
    expect(en["engines.inUseSuffix"]).toBe("{cli} · in use");
    expect(ko["engines.inUseSuffix"]).toBe("{cli} · 사용 중");
    expect(translate("en", "engines.inUseSuffix", { cli: "/usr/bin/claude" })).toBe("/usr/bin/claude · in use");
    expect(translate("ko", "engines.inUseSuffix", { cli: "/usr/bin/claude" })).toBe("/usr/bin/claude · 사용 중");
    expect(en["connections.connected"]).toBe("Connected");
    expect(ko["connections.connected"]).toBe("연결됨");
    expect(en["settings.connections.subtitle"]).toBe(
      "Set the CLI for Grok, Claude, Codex, and Antigravity. Paste an API key for Gemini and OpenCode.",
    );
    expect(ko["settings.connections.subtitle"]).toBe(
      "Grok, Claude, Codex, Antigravity는 CLI를 지정합니다. Gemini와 OpenCode는 API 키를 붙여넣습니다.",
    );
    expect(ko["settings.connections.subtitle"]).not.toMatch(/Set the CLI|Paste an API key/i);
    const enParts = splitTwoSentences(en["settings.connections.subtitle"]);
    expect(enParts.cli).toMatch(/Grok/);
    expect(enParts.cli).toMatch(/Claude/);
    expect(enParts.cli).toMatch(/Codex/);
    expect(enParts.cli).toMatch(/Antigravity/);
    expect(enParts.cli).not.toMatch(/Gemini|OpenCode/);
    expect(enParts.key).toMatch(/Gemini/);
    expect(enParts.key).toMatch(/OpenCode/);
    expect(enParts.key).not.toMatch(/Grok|Claude|Codex|Antigravity/);
    const koParts = splitTwoSentences(ko["settings.connections.subtitle"]);
    expect(koParts.cli).toMatch(/Grok/);
    expect(koParts.cli).toMatch(/Claude/);
    expect(koParts.cli).toMatch(/Codex/);
    expect(koParts.cli).toMatch(/Antigravity/);
    expect(koParts.cli).not.toMatch(/Gemini|OpenCode/);
    expect(koParts.key).toMatch(/Gemini/);
    expect(koParts.key).toMatch(/OpenCode/);
    expect(koParts.key).not.toMatch(/Grok|Claude|Codex|Antigravity/);
  });

  it("wires those phrases instead of hardcoded English", () => {
    expect(engineSetup).toContain('t("engine.signInTo"');
    expect(engineSetup).toContain('t("engine.installName"');
    expect(engineSetup).toContain('t("engine.copyCommand")');
    expect(engineSetup).toContain('t("engine.openConnections")');
    expect(engineSetup).toContain('t("engine.needsKey")');
    expect(engineSetup).not.toMatch(/Open install in Terminal/);
    expect(approvalCard).toContain('t("approval.wantsNamed"');
    expect(approvalCard).toContain('t("approval.allowed")');
    expect(pendingApproval).toContain('t("approval.alwaysAllow")');
    expect(pendingApproval).toContain('t("approval.cancelTurn")');
    expect(pendingApproval).not.toMatch(/>Always allow</);
    expect(secretRequestCard).toContain('t("secret.saveSecurely")');
    expect(secretRequestCard).not.toMatch(/Where to get this key/);
    expect(sidebar).toContain('t("chrome.add")');
    expect(sidebar).toContain('t("chrome.removeFromContext")');
    expect(sidebar).toContain('t("palette.noMatch"');
    expect(sidebar).not.toMatch(/Remove from context/);
    expect(taskPicker).toContain('t("task.new")');
    expect(taskPicker).toContain('t("palette.noMatch"');
    expect(taskPicker).not.toMatch(/>New task</);
    expect(renameTitle).toContain('t("rename.named"');
    expect(renameTitle).toContain('t("chat.openProfile"');
    expect(chatView).toContain('t("createBot.cancel")');
    expect(chatView).toContain('t("composer.send")');
    expect(chatView).toContain('t("chat.startConversation")');
    expect(chatView).toContain('t("chrome.chiefOfStaff")');
    expect(chatView).not.toMatch(/Send a message to start the conversation/);
    expect(modelPicker).toContain('t("palette.noMatch"');
    expect(modelPicker).toContain('t("model.automatic")');
    expect(modelPicker).toContain('t("model.switchEngine")');
    expect(modelPicker).toContain('t("model.automaticHelp"');
    expect(modelPicker).toContain('t("engines.models")');
    expect(modelPicker).not.toMatch(/Nothing matches/);
    expect(modelPicker).not.toMatch(/>Switch engine</);
    expect(modelPicker).not.toMatch(/>Cloud</);
    expect(enginesSettings).toContain('t("engines.setCli")');
    expect(enginesSettings).toContain('t("engines.models")');
    expect(enginesSettings).toContain('t("engines.inUseSuffix"');
    expect(enginesSettings).not.toMatch(/>Set CLI…</);
    expect(enginesSettings).not.toMatch(/· in use/);
    expect(enginesSettings).not.toMatch(/>Cloud</);
  });
});

describe("sidebar empty message search", () => {
  it("keeps sidebar message-search empty copy as complete EN+KO phrases", () => {
    expect(en["palette.messages"]).toBe("Messages");
    expect(ko["palette.messages"]).toBe("메시지");
    expect(en["search.messagesCount"]).toBe("Messages · {count}");
    expect(ko["search.messagesCount"]).toBe("메시지 · {count}");
    expect(en["search.noMatch"]).toBe("No messages match “{query}”");
    expect(ko["search.noMatch"]).toBe("“{query}”와 일치하는 메시지가 없습니다");
    expect(ko["search.noMatch"]).not.toMatch(/No messages match/i);
    expect(ko["search.messagesCount"]).not.toMatch(/Messages/i);
    expect(translate("en", "search.noMatch", { query: "keep this query" })).toBe("No messages match “keep this query”");
    expect(translate("ko", "search.noMatch", { query: "keep this query" })).toContain("keep this query");
    expect(Object.hasOwn(catalogs.en, "keep this query")).toBe(false);
    expect(en["room.saveMembersOne"]).toBe("Save · {count} bot");
    expect(en["room.saveMembersMany"]).toBe("Save · {count} bots");
    expect(ko["room.saveMembersOne"]).toBe("저장 · 봇 {count}개");
    expect(ko["room.saveMembersMany"]).toBe("저장 · 봇 {count}개");
    expect(ko["room.saveMembersOne"]).not.toMatch(/Save|\bbot\b/i);
    expect(ko["room.saveMembersMany"]).not.toMatch(/Save|\bbots\b/i);
  });

  it("wires those phrases into SearchResults and Manage Members without t(query)", () => {
    expect(searchResults).toContain('t("palette.messages")');
    expect(searchResults).toContain('t("search.messagesCount"');
    expect(searchResults).toContain('t("search.noMatch"');
    expect(searchResults).toContain("{ query: q }");
    expect(searchResults).not.toMatch(/No messages match/);
    expect(searchResults).not.toMatch(/Messages\{hits/);
    expect(searchResults).toContain('t("search.noMatch", { query: q })');
    expect(searchResults).not.toMatch(/\bt\(\s*(q|query)\s*\)/);
    expect(manageMembers).toContain('t("createBot.cancel")');
    expect(manageMembers).toContain('t("room.save")');
    expect(manageMembers).toContain('"room.saveMembersOne"');
    expect(manageMembers).toContain('"room.saveMembersMany"');
    expect(manageMembers).not.toMatch(/>Cancel</);
    expect(manageMembers).not.toMatch(/Save\{memberIds/);
  });
});

describe("plan usage", () => {
  it("keeps the usage window phrases complete in English and Korean", () => {
    expect(en["usage.limits.title"]).toBe("Plan usage");
    expect(ko["usage.limits.title"]).toBe("요금제 사용량");
    // Same glyphs on purpose: the Grok row is a bare figure. Korean “used”
    // stays on the window labels below, not as a suffix on the percent.
    expect(en["usage.limits.percentUsed"]).toBe("{percent}%");
    expect(ko["usage.limits.percentUsed"]).toBe("{percent}%");
    expect(ko["usage.limits.weekly"]).toBe("주간 한도");
    expect(en["usage.limits.sessionShort"]).toBe("5h");
    expect(ko["usage.limits.sessionShort"]).toBe("5시간");
    expect(en["usage.limits.weeklyShort"]).toBe("Weekly");
    expect(ko["usage.limits.weeklyShort"]).toBe("주간");
    expect(en["usage.limits.compactHm"]).toBe("{hours}h{minutes}m");
    expect(ko["usage.limits.compactHm"]).toBe("{hours}h{minutes}m");
    expect(en["usage.limits.compactDh"]).toBe("{days}d{hours}h");
    expect(ko["usage.limits.compactDh"]).toBe("{days}d{hours}h");
    expect(en["usage.limits.resetsInDays"]).toBe("Resets in {days} days");
    expect(ko["usage.limits.resetsInDays"]).toBe("{days}일 후 초기화");
    expect(en["usage.limits.resetsInOneDay"]).toBe("Resets in 1 day");
    expect(ko["usage.limits.resetsInOneDay"]).toBe("1일 후 초기화");
    expect(en["usage.limits.resetsInHours"]).toBe("Resets in {hours} hours");
    expect(ko["usage.limits.resetsInHours"]).toBe("{hours}시간 후 초기화");
    expect(en["usage.limits.resetsInMinutes"]).toBe("Resets in {minutes} minutes");
    expect(ko["usage.limits.resetsInMinutes"]).toBe("{minutes}분 후 초기화");
    for (const key of [
      "usage.limits.session",
      "usage.limits.weekly",
      "usage.limits.sessionShort",
      "usage.limits.weeklyShort",
      "usage.limits.resetsInHours",
      "usage.limits.resetsInOneHour",
      "usage.limits.resetsInMinutes",
      "usage.limits.resetsInOneMinute",
      "usage.limits.resetUnknown",
      "usage.limits.resetPassed",
      "usage.limits.pending",
      "usage.limits.notReported",
    ] as const) {
      expect(ko[key]).not.toMatch(/Resets|window|report|used|Weekly/i);
    }
    expect(ko["usage.limits.pending"]).toContain("{name}");
    expect(ko["usage.limits.notReported"]).toContain("{name}");
    expect(ko["usage.limits.unavailable"]).toContain("{name}");
    expect(ko["usage.limits.pending"]).not.toMatch(/not available|at the moment/i);
    expect(translate("en", "usage.limits.pending", { name: "Claude" })).toBe(
      "Appears after your next Claude message",
    );
    expect(translate("en", "usage.limits.unavailable", { name: "Grok" })).toBe(
      "Grok does not report a usage limit.",
    );
    expect(translate("ko", "usage.limits.resetsInDays", { days: 2 })).toBe("2일 후 초기화");
    expect(translate("en", "usage.limits.resetsInDays", { days: 2 })).toBe("Resets in 2 days");
    expect(translate("en", "usage.limits.percentUsed", { percent: 76 })).toBe("76%");
    expect(translate("ko", "usage.limits.percentUsed", { percent: 76 })).toBe("76%");
    expect(translate("en", "usage.limits.compactHm", { hours: 1, minutes: 55 })).toBe("1h55m");
    expect(translate("ko", "usage.limits.compactHm", { hours: 1, minutes: 55 })).toBe("1h55m");
    expect(translate("en", "usage.limits.compactDh", { days: 2, hours: 5 })).toBe("2d5h");
    expect(translate("en", "usage.limits.compactD", { days: 2 })).toBe("2d");
    expect(translate("en", "usage.limits.compactH", { hours: 3 })).toBe("3h");
    expect(translate("en", "usage.limits.compactM", { minutes: 20 })).toBe("20m");
    expect(translate("ko", "usage.limits.notReported", { name: "Grok" })).toBe("Grok은(는) 사용 한도를 보고하지 않습니다.");
  });

  it("wires those phrases into the Usage settings surface instead of hardcoded English", () => {
    expect(usageSection).toContain('t("usage.limits.title")');
    expect(usageSection).toContain('t("usage.limits.subtitle")');
    expect(usageSection).toContain('t("usage.limits.empty")');
    expect(planUsageBar).toContain('"usage.limits.session"');
    expect(planUsageBar).toContain('"usage.limits.weekly"');
    expect(planUsageBar).toContain('"usage.limits.window"');
    expect(planUsageBar).toContain('"usage.limits.sessionShort"');
    expect(planUsageBar).toContain('"usage.limits.weeklyShort"');
    expect(planUsageBar).toContain('t("usage.limits.percentUsed", { percent })');
    expect(usageSection).toContain('"usage.limits.pending"');
    expect(usageSection).toContain('"usage.limits.unavailable"');
    expect(planUsageBar).toContain("t(phrase.key, phrase.vars)");
    expect(planUsageBar).toContain("t(compactReset.key, compactReset.vars)");
    expect(usageSection).not.toMatch(/Resets in/);
    expect(planUsageBar).not.toMatch(/Resets in/);
    expect(usageSection).not.toMatch(/% used/);
    expect(usageSection).not.toMatch(/does not report/);
    expect(usageSection).not.toMatch(/not available at the moment/);
    expect(chatPlanMeters).toContain('t("usage.limits.title")');
    expect(chatPlanMeters).not.toMatch(/Resets in/);
    expect(chatView).toContain("<ChatPlanMeters");
    expect(chatView).toContain("engine?.rateLimits?.windows");
  });
});

describe("chat reactions", () => {
  const reactions = readFileSync(join(here, "../components/Reactions.tsx"), "utf8");

  it("keeps reaction chrome as complete EN+KO phrases", () => {
    expect(en["chat.reactEmoji"]).toBe("React {emoji}");
    expect(ko["chat.reactEmoji"]).toBe("{emoji} 반응 달기");
    expect(en["chat.removeReaction"]).toBe("Remove {emoji} reaction");
    expect(ko["chat.removeReaction"]).toBe("{emoji} 반응 취소");
    expect(en["chat.moreReactions"]).toBe("More reactions");
    expect(ko["chat.moreReactions"]).toBe("다른 반응");
    expect(en["chat.closeReactions"]).toBe("Close reactions");
    expect(ko["chat.closeReactions"]).toBe("반응 닫기");
    expect(ko["chat.moreReactions"]).not.toMatch(/More reactions/i);
  });

  it("wires those phrases into the reaction rail instead of hardcoded English", () => {
    expect(reactions).toContain('t("chat.reactEmoji"');
    expect(reactions).toContain('t("chat.removeReaction"');
    expect(reactions).toContain('t("chat.moreReactions")');
    expect(reactions).toContain('t("chat.closeReactions")');
    expect(reactions).not.toMatch(/aria-label="More reactions"/);
    expect(reactions).not.toMatch(/title="More reactions"/);
  });
});

describe("Continuity recovery and compaction chrome", () => {
  const recovery = readFileSync(join(here, "../components/TaskRecoveryCard.tsx"), "utf8");

  it("keeps Resume and compaction disclosure as complete EN+KO phrases", () => {
    expect(en["chat.resume"]).toBe("Resume");
    expect(ko["chat.resume"]).toBe("재개");
    expect(en["chat.resuming"]).toBe("Resuming…");
    expect(ko["chat.resuming"]).toBe("재개 중…");
    expect(en["chat.compactionSummarized"]).toBe("Earlier messages summarized · Full chat kept");
    expect(ko["chat.compactionSummarized"]).toBe("이전 메시지는 요약됨 · 전체 대화는 유지됨");
    expect(en["chat.compactionUnsupported"]).toMatch(/newer Orbit version/);
    expect(ko["chat.compactionUnsupported"]).not.toMatch(/Context summary|Orbit version/i);
    expect(ko["chat.resuming"]).not.toMatch(/Resuming/i);
    expect(Object.hasOwn(en, "chat.continue")).toBe(false);
    expect(Object.hasOwn(ko, "chat.continue")).toBe(false);
  });

  it("wires those phrases instead of hardcoded English", () => {
    expect(recovery).toContain('t("chat.resume")');
    expect(recovery).toContain('t("chat.resuming")');
    expect(recovery).toContain('t("chat.compactionSummarized")');
    expect(recovery).toContain('t("chat.compactionUnsupported")');
    expect(recovery).not.toMatch(/Older context was summarized/);
    expect(recovery).not.toMatch(/Context summary requires a newer Orbit version/);
  });
});
