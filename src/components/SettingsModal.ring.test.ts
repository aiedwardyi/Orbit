// Programmatic mount-focus on the Settings dialog (tabIndex -1) trips the
// unlayered global :focus-visible ring, drawing an outline around the whole
// modal for keyboard users. The dialog must stay focusable, so the stylesheet
// exempts [role="dialog"][tabindex="-1"] instead. jsdom does not match
// :focus-visible, so this pins the stylesheet contract directly.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../styles.css"),
  "utf8",
);

describe("modal dialog focus ring exemption", () => {
  it("keeps the global :focus-visible ring for everything else", () => {
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--color-focus\)/);
  });

  it("exempts programmatic dialog containers from the global ring", () => {
    expect(css).toMatch(
      /\[role="dialog"\]\[tabindex="-1"\]:focus-visible\s*\{\s*outline:\s*none/,
    );
  });

  it("gives the General Profile Name field the same accent focus ring", () => {
    expect(css).toMatch(
      /#settings-profile-name:focus-visible\s*\{\s*outline:\s*2px solid var\(--color-focus\)/,
    );
  });
});
