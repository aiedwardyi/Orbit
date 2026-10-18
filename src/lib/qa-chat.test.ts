import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { en, ko } from "./i18n-catalog";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("qa chat copy", () => {
  it("explains memory and work steps in place", () => {
    expect(en["bot.memoryPlaceholder"]).toBe(
      "What it learns. The bot writes this.",
    );
    expect(ko["bot.memoryPlaceholder"]).toBe("봇이 배운 것. 봇이 직접 적어요.");
    expect(ko["bot.name"]).toBe("이름");
    expect(ko["bot.memory"]).toBe("메모리");
    expect(en["settings.toolCalls.toggle"]).toBe("Work steps");
    expect(ko["settings.toolCalls.toggle"]).toBe("작업 과정");
    expect(en["settings.toolCalls.aria"]).toBe("Work steps");
    expect(ko["settings.toolCalls.aria"]).toBe("작업 과정");
  });

  it("wires those phrases and the search find bar", () => {
    const panel = read("components/SettingsPanel.tsx");
    const find = read("components/ChatFindBar.tsx");
    expect(panel).toContain('t("bot.memoryPlaceholder")');
    expect(panel).toContain('t("bot.name")');
    expect(panel).toContain('t("bot.memory")');
    expect(find).toContain("initialQuery");
    expect(read("components/ChatView.tsx")).toContain("initialQuery");
    expect(read("components/GroupView.tsx")).toContain("initialQuery");
    expect(read("components/SearchResults.tsx")).toContain("highlightParts");
  });

  it("names the tab when a link opens settings for one job", () => {
    for (const file of ["components/ComputerPanel.tsx", "components/PluginsPanel.tsx"]) {
      const opens = read(file).match(/\{ type: "toggleAppSettings", open: true[^}]*\}/g) ?? [];
      expect(opens.length).toBeGreaterThan(0);
      for (const open of opens) expect(open).toContain("section:");
    }
  });
});
