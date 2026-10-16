import { describe, expect, it } from "vitest";

import { SESSION_NOTICE_REPEAT_MS, sessionNoticeDue } from "./session-notice.ts";

describe("sessionNoticeDue", () => {
  it("is due once per session", () => {
    expect(sessionNoticeDue({}, "s1", "notes:t1", 100)).toBe(true);
    const shown = { "notes:t1": { cursor: "s1", at: 100 } };
    expect(sessionNoticeDue(shown, "s1", "notes:t1", 200)).toBe(false);
    expect(sessionNoticeDue(shown, "s2", "notes:t1", 200)).toBe(true);
    expect(sessionNoticeDue(shown, "s1", "notes:t2", 200)).toBe(true);
  });

  it("is due again after a day in the same session", () => {
    const shown = { k: { cursor: "s1", at: 100 } };
    expect(sessionNoticeDue(shown, "s1", "k", 100 + SESSION_NOTICE_REPEAT_MS - 1)).toBe(false);
    expect(sessionNoticeDue(shown, "s1", "k", 100 + SESSION_NOTICE_REPEAT_MS)).toBe(true);
  });
});
