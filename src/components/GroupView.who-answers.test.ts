import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { responderControlLabel } from "@/lib/group-routing";
import { translate, type Translate } from "@/lib/i18n";
import { en, ko } from "@/lib/i18n-catalog";

const here = dirname(fileURLToPath(import.meta.url));
const groupView = readFileSync(join(here, "GroupView.tsx"), "utf8");

const enT: Translate = (key, vars) => translate("en", key, vars);
const koT: Translate = (key, vars) => translate("ko", key, vars);

describe("who answers label", () => {
  it("names the closed control in English and Korean", () => {
    expect(en["room.whoAnswers"]).toBe("Who answers: {name}");
    expect(ko["room.whoAnswers"]).toBe("답변: {name}");
    expect(en["room.whoAnswersEveryone"]).toBe("Who answers: Everyone");
    expect(ko["room.whoAnswersEveryone"]).toBe("답변: 모두");
    expect(enT("room.leadLabel", { name: "Ada" })).toBe("Lead: Ada");
    expect(responderControlLabel("member", "Ada", enT)).toBe("Who answers: Ada");
    expect(responderControlLabel("member", undefined, enT)).toBe("Who answers: The lead bot");
    expect(responderControlLabel("everyone", undefined, enT)).toBe("Who answers: Everyone");
    expect(responderControlLabel("mentions", undefined, enT)).toBe("Only when mentioned");
    expect(responderControlLabel("member", "Ada", koT)).toBe("답변: Ada");
    expect(responderControlLabel("everyone", undefined, koT)).toBe("답변: 모두");
    expect(responderControlLabel("member", undefined, koT)).toBe("답변: 리더 봇");
  });

  it("shows that label on the closed control and leaves the menu rows", () => {
    const start = groupView.indexOf("function DefaultResponderSelect");
    const end = groupView.indexOf("function RoomWorkingFolder");
    const block = groupView.slice(start, end);
    expect(block).toContain("responderControlLabel");
    expect(block).toContain("data-who-answers");
    expect(block).toContain("text-transparent");
    expect(block).toContain('t("room.leadLabel"');
    expect(block).toContain('t("room.everyoneResponds")');
    expect(block).toContain('t("room.titleLead"');
  });
});
