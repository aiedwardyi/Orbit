import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sidebarConversationRowTone } from "./sidebar-row";

const sidebar = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../components/Sidebar.tsx"),
  "utf8",
);

describe("sidebar conversation row tone", () => {
  it("gives only the selected conversation strong row emphasis", () => {
    expect(sidebarConversationRowTone(true)).toContain("bg-raised");
    expect(sidebarConversationRowTone(true)).not.toContain("bg-accent");
    expect(sidebarConversationRowTone(true)).not.toContain("border-accent");
  });

  it("does not paint Chief/blue chrome onto an unselected row", () => {
    expect(sidebarConversationRowTone(false)).not.toContain("bg-accent");
    expect(sidebarConversationRowTone(false)).not.toContain("border-accent");
    expect(sidebarConversationRowTone(false)).toContain("hover:bg-raised/50");
    expect(sidebarConversationRowTone(false)).toContain("border-transparent");
  });

  it("wires that tone into BotListItem and keeps the Chief badge", () => {
    expect(sidebar).toContain("sidebarConversationRowTone(selected)");
    expect(sidebar).not.toMatch(/chiefOfStaff\s*\n\s*\? selected/);
    expect(sidebar).toContain('t("chrome.chiefOfStaff")');
    expect(sidebar).toContain("<Crown");
  });
});
