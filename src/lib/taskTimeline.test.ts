import { describe, expect, it } from "vitest";

import { localizeServerLine } from "./activity-runs";
import { translate } from "./i18n";
import { timelineEvents } from "./taskTimeline";

describe("timeline labels", () => {
  it("translates step names in Korean and preserves tool names", () => {
    const events = timelineEvents([
      { id: "start", role: "user", kind: "text", text: "Research this", at: 1 },
      { id: "tool", role: "bot", kind: "activity", tool: { name: "browser.search", ok: true }, at: 2 },
      { id: "screen", role: "bot", kind: "screen", at: 3 },
      { id: "response", role: "bot", kind: "text", text: "Done", at: 4 },
      { id: "input", role: "user", kind: "text", text: "Continue", at: 5 },
    ], (line) => localizeServerLine(line, (key, vars) => translate("ko", key, vars)));

    expect(events.map((event) => event.label)).toEqual(["작업 시작", "browser.search", "화면 확인", "응답 기록", "사용자 입력"]);
  });
});
