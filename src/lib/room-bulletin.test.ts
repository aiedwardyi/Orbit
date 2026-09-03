import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { nextBulletin } from "./room-bulletin";

const here = dirname(fileURLToPath(import.meta.url));
const groupView = readFileSync(join(here, "../components/GroupView.tsx"), "utf8");

describe("nextBulletin", () => {
  it("skips an unchanged draft", () => {
    expect(nextBulletin("ship it", "ship it")).toBeNull();
    expect(nextBulletin("", "")).toBeNull();
  });

  it("commits an emptied draft", () => {
    expect(nextBulletin("ship it", "")).toBe("");
  });

  it("commits an edited draft verbatim", () => {
    expect(nextBulletin("ship it", "  ship it later\n")).toBe("  ship it later\n");
  });
});

describe("channel bulletin editor", () => {
  it("does not commit on blur", () => {
    expect(groupView).toContain("saveBulletin");
    expect(groupView).not.toMatch(/onBlur=\{[^}]*saveBulletin/);
  });
});
