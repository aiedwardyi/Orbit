import { describe, expect, it } from "vitest";

import { initialState, reducer } from "./store";

describe("bot details avatar request", () => {
  it("opens the picker from the avatar and clears it for the pencil", () => {
    const avatar = reducer(initialState, { type: "toggleSettings", open: true, avatar: true });
    expect(avatar.settingsOpen).toBe(true);
    expect(avatar.settingsAvatarRequest).toBe(1);
    const again = reducer(avatar, { type: "toggleSettings", open: true, avatar: true });
    expect(again.settingsAvatarRequest).toBe(2);
    const pencil = reducer(again, { type: "toggleSettings", open: true });
    expect(pencil.settingsOpen).toBe(true);
    expect(pencil.settingsAvatarRequest).toBe(0);
    const closed = reducer(avatar, { type: "toggleSettings", open: false });
    expect(closed.settingsOpen).toBe(false);
    expect(closed.settingsAvatarRequest).toBe(0);
  });
});
