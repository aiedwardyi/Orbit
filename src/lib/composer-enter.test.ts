import { describe, expect, it } from "vitest";

import { composerEnterIntent, isComposerEnterKey } from "./composer-enter";

function enter(
  overrides: {
    shiftKey?: boolean;
    key?: string;
    code?: string;
    keyCode?: number;
    isComposing?: boolean;
  } = {},
) {
  return {
    key: overrides.key ?? "Enter",
    code: overrides.code ?? "Enter",
    shiftKey: overrides.shiftKey ?? false,
    keyCode: overrides.keyCode,
    isComposing: overrides.isComposing,
  };
}

const idle = { composing: false, justEnded: false };

describe("isComposerEnterKey", () => {
  it("matches Enter and NumpadEnter, including NumpadEnter without key Enter", () => {
    expect(isComposerEnterKey({ key: "Enter" })).toBe(true);
    expect(isComposerEnterKey({ key: "Enter", code: "NumpadEnter" })).toBe(true);
    expect(isComposerEnterKey({ key: "Unidentified", code: "NumpadEnter" })).toBe(true);
    expect(isComposerEnterKey({ key: "Tab", code: "Tab" })).toBe(false);
    expect(isComposerEnterKey({ key: "Unidentified", code: "Enter" })).toBe(false);
  });
});

describe("composerEnterIntent", () => {
  it("sends on plain Enter when the composer is idle", () => {
    expect(composerEnterIntent(enter({ keyCode: 13 }), idle)).toBe("send");
  });

  it("inserts a newline on Shift+Enter", () => {
    expect(composerEnterIntent(enter({ shiftKey: true, keyCode: 13 }), idle)).toBe("newline");
  });

  it("does not send while an IME is composing", () => {
    expect(composerEnterIntent(enter({ keyCode: 13, isComposing: true }), { composing: true, justEnded: false })).toBe(
      "none",
    );
  });

  it("does not send the Windows IME confirm-Enter (keyCode 229)", () => {
    expect(composerEnterIntent(enter({ keyCode: 229, isComposing: true }), idle)).toBe("none");
  });

  it("does not send the Enter that lands in the same frame as compositionend", () => {
    expect(composerEnterIntent(enter({ keyCode: 13 }), { composing: false, justEnded: true })).toBe("none");
  });

  it("still sends when isComposing is stuck after composition has ended", () => {
    expect(composerEnterIntent(enter({ keyCode: 13, isComposing: true }), idle)).toBe("send");
  });

  it("does not send-through a stuck isComposing flag when keyCode is missing", () => {
    expect(composerEnterIntent(enter({ isComposing: true }), idle)).toBe("none");
  });

  it("sends NumpadEnter the same as Enter", () => {
    expect(composerEnterIntent(enter({ code: "NumpadEnter", keyCode: 13 }), idle)).toBe("send");
    expect(composerEnterIntent(enter({ key: "Unidentified", code: "NumpadEnter", keyCode: 13 }), idle)).toBe("send");
  });

  it("does not treat code Enter alone as a send key", () => {
    expect(composerEnterIntent(enter({ key: "Unidentified", code: "Enter", keyCode: 13 }), idle)).toBe("none");
  });

  it("ignores other keys", () => {
    expect(composerEnterIntent(enter({ key: "Tab", code: "Tab", keyCode: 9 }), idle)).toBe("none");
  });

  it("reads isComposing and keyCode from nativeEvent the way React keydown does", () => {
    expect(
      composerEnterIntent(
        { key: "Enter", code: "Enter", shiftKey: false, nativeEvent: { isComposing: false, keyCode: 13 } },
        idle,
      ),
    ).toBe("send");
    expect(
      composerEnterIntent(
        { key: "Enter", code: "Enter", shiftKey: false, nativeEvent: { isComposing: true, keyCode: 229 } },
        idle,
      ),
    ).toBe("none");
    expect(
      composerEnterIntent(
        { key: "Enter", code: "Enter", shiftKey: false, nativeEvent: { isComposing: true, keyCode: 13 } },
        idle,
      ),
    ).toBe("send");
  });
});
