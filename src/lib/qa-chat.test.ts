import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { en, ko } from "./i18n-catalog";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("qa chat copy", () => {
  it("says the sync folder is only for chats between PCs", () => {
    expect(en["settings.sync.folderHelp"]).toBe(
      "This folder only syncs chats between your PCs. It is not where bots work. Pick the same folder on each PC.",
    );
    expect(ko["settings.sync.folderHelp"]).toBe(
      "이 폴더는 PC끼리 대화를 맞출 때만 써요. 봇이 일하는 곳이 아니에요. PC마다 같은 폴더를 고르세요.",
    );
  });

  it("explains archive, memory, and work steps in place", () => {
    expect(en["chrome.archiveHint"]).toBe("Hide from the list. The chat is kept.");
    expect(ko["chrome.archiveHint"]).toBe("목록에서 숨겨요. 대화는 그대로 남아요.");
    expect(en["bot.memoryPlaceholder"]).toBe(
      "This is where the bot saves rules and facts to remember.",
    );
    expect(ko["bot.memoryPlaceholder"]).toBe("봇이 기억해야 할 규칙과 사실이 여기에 저장돼요.");
    expect(ko["bot.name"]).toBe("이름");
    expect(ko["bot.memory"]).toBe("메모리");
    expect(en["settings.toolCalls.toggle"]).toBe("Show work steps");
    expect(ko["settings.toolCalls.toggle"]).toBe("작업 과정 보기");
    expect(en["settings.toolCalls.aria"]).toBe("Show work steps");
    expect(ko["settings.toolCalls.aria"]).toBe("작업 과정 보기");
  });

  it("wires those phrases and the search find bar", () => {
    const sidebar = read("components/Sidebar.tsx");
    const panel = read("components/SettingsPanel.tsx");
    const find = read("components/ChatFindBar.tsx");
    expect(sidebar).toContain('t("chrome.archiveHint")');
    expect(panel).toContain('t("bot.memoryPlaceholder")');
    expect(panel).toContain('t("bot.name")');
    expect(panel).toContain('t("bot.memory")');
    expect(find).toContain("initialQuery");
    expect(read("components/ChatView.tsx")).toContain("initialQuery");
    expect(read("components/GroupView.tsx")).toContain("initialQuery");
    expect(read("components/SearchResults.tsx")).toContain("highlightParts");
  });
});
