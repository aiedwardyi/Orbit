import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { composerEnterIntent } from "./composer-enter";

const here = dirname(fileURLToPath(import.meta.url));
const composer = readFileSync(join(here, "../components/Composer.tsx"), "utf8");

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

  it("sends NumpadEnter the same as Enter", () => {
    expect(composerEnterIntent(enter({ code: "NumpadEnter", keyCode: 13 }), idle)).toBe("send");
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

describe("composer Enter wiring", () => {
  it("uses composerEnterIntent so Enter sends and IME confirm does not", () => {
    expect(composer).toContain("composerEnterIntent");
    expect(composer).toContain("onCompositionStart");
    expect(composer).toContain("onCompositionEnd");
    expect(composer).toContain("composingRef.current");
    expect(composer).toContain("compositionEndedAtRef");
    expect(composer).toContain("onBlur");
  });
});
