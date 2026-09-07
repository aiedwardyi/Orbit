// The 600x480 window floor is a product target, not a tolerance: overlay
// chrome that only fits a roomy window is a defect at the size the window
// manager will actually hand us. These model the floor from the real class
// strings, the same way composer-dock.test.ts models the composer layer.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CHAT_MIN_WIDTH, DETAILS_PANEL_WIDTH, SIDEBAR_INLINE_BREAKPOINT } from "@/lib/sidebar-preferences";

const here = dirname(fileURLToPath(import.meta.url));

type Source = { file: string; text: string };

function componentSource(file: string): Source {
  return { file, text: readFileSync(join(here, file), "utf8") };
}

const settingsModal = componentSource("SettingsModal.tsx");
const settingsPanel = componentSource("SettingsPanel.tsx");

const WINDOW_FLOOR = { width: 600, height: 480 };

type Box = { x: number; y: number; w: number; h: number };

/** The className literal carrying `needle`, so a test names a layout rule
 * rather than a line number. Only plain `className="..."` is read: a move
 * into cn() or a template literal has to say so by name here. */
function classAttr(source: Source, needle: string): string {
  for (const [, value] of source.text.matchAll(/className="([^"]*)"/g)) {
    if (value.includes(needle)) return value;
  }
  throw new Error(
    `${source.file}: no plain className="..." contains "${needle}". ` +
    "If that class moved into cn() or a template literal, teach classAttr to read it.",
  );
}

function px(cls: string, utility: string): number | null {
  const match = cls.match(new RegExp(`(?:^|\\s)${utility}-\\[(\\d+)px\\]`));
  return match ? Number(match[1]) : null;
}

/** Tailwind's own precedence, so a directional variant cannot silently read
 * as an unpadded overlay: `p-N`, overridden by `py-N`, then by `pt-N`/`pb-N`. */
function verticalPad(cls: string) {
  const scale = (utility: string) => {
    const match = cls.match(new RegExp(`(?:^|\\s)${utility}-(\\d+)(?:\\s|$)`));
    return match ? Number(match[1]) * 4 : null;
  };
  const axis = scale("py") ?? scale("p") ?? 0;
  return { top: scale("pt") ?? axis, bottom: scale("pb") ?? axis };
}

/** `items-center` inside a `fixed inset-0` overlay, clamped by whatever the
 * dialog accepts as a maximum. */
function centredDialog(overlayClass: string, dialogClass: string, viewportHeight: number): Box {
  const pad = verticalPad(overlayClass);
  const available = viewportHeight - pad.top - pad.bottom;
  const asked = px(dialogClass, "h") ?? available;
  const capped = /(?:^|\s)max-h-full(?:\s|$)/.test(dialogClass)
    ? Math.min(asked, available)
    : Math.min(asked, px(dialogClass, "max-h") ?? Infinity);
  return { x: 0, y: pad.top + (available - capped) / 2, w: 0, h: capped };
}

describe("floor model helpers", () => {
  it("reads directional padding and names the file it could not match", () => {
    expect(verticalPad("fixed inset-0 py-6")).toEqual({ top: 24, bottom: 24 });
    expect(verticalPad("fixed inset-0 p-6 pt-2")).toEqual({ top: 8, bottom: 24 });
    expect(() => classAttr(settingsModal, "no-such-utility")).toThrow(/SettingsModal\.tsx/);
    expect(() => classAttr(settingsModal, "no-such-utility")).toThrow(/no-such-utility/);
  });
});

describe("App settings at the window floor", () => {
  const overlayClass = classAttr(settingsModal, "fixed inset-0 z-50");
  const dialogClass = classAttr(settingsModal, "max-w-[860px]");

  it("keeps the whole dialog inside the visible window at 600x480", () => {
    const dialog = centredDialog(overlayClass, dialogClass, WINDOW_FLOOR.height);
    expect(dialog.y).toBeGreaterThanOrEqual(0);
    expect(dialog.y + dialog.h).toBeLessThanOrEqual(WINDOW_FLOOR.height);
  });

  it("keeps the heading and close button on screen at 600x480", () => {
    const dialog = centredDialog(overlayClass, dialogClass, WINDOW_FLOOR.height);
    // Heading row: py-3 either side of a 20px line.
    const headerRow: Box = { x: 0, y: dialog.y, w: 0, h: 44 };
    expect(headerRow.y).toBeGreaterThanOrEqual(0);
    expect(headerRow.y + headerRow.h).toBeLessThanOrEqual(WINDOW_FLOOR.height);
  });

  it("scrolls only the content pane, so the header cannot scroll away", () => {
    const contentColumn = settingsModal.text.slice(settingsModal.text.indexOf('id="app-settings-title"'));
    expect(contentColumn.indexOf("overflow-y-auto")).toBeGreaterThan(contentColumn.indexOf("settings.close"));
    expect(classAttr(settingsModal, "justify-between px-5 py-3")).toContain("shrink-0");
  });
});

/** Below SIDEBAR_INLINE_BREAKPOINT the sidebar is already a drawer, so the
 * chat owns the whole window unless Bot details docks in the flow beside it. */
function detailsFloorLayout(asideClass: string, viewportWidth: number) {
  const docked = !(/max-md:absolute/.test(asideClass) && viewportWidth < SIDEBAR_INLINE_BREAKPOINT);
  const asked = px(asideClass, "w") ?? 0;
  const width = docked ? asked : /max-md:w-full/.test(asideClass) ? viewportWidth : asked;
  return {
    chat: { x: 0, y: 0, w: docked ? viewportWidth - width : viewportWidth, h: WINDOW_FLOOR.height },
    details: { x: viewportWidth - width, y: 0, w: width, h: WINDOW_FLOOR.height },
  };
}

describe("Bot details at the window floor", () => {
  const asideClass = classAttr(settingsPanel, "w-[400px]");

  it("never lays the chat out narrower than the window at 600x480", () => {
    const { chat } = detailsFloorLayout(asideClass, WINDOW_FLOOR.width);
    expect(chat.w).toBe(WINDOW_FLOOR.width);
  });

  it("either covers the chat or leaves a usable column beside it", () => {
    const { chat, details } = detailsFloorLayout(asideClass, WINDOW_FLOOR.width);
    const uncovered = Math.max(0, details.x - chat.x);
    expect(uncovered === 0 || uncovered >= CHAT_MIN_WIDTH).toBe(true);
  });

  it("docks in the flow once the window can host details and a usable chat", () => {
    const wide = SIDEBAR_INLINE_BREAKPOINT + CHAT_MIN_WIDTH + 400;
    const { chat, details } = detailsFloorLayout(asideClass, wide);
    expect(details.w).toBe(400);
    expect(chat.w).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
  });

  it("keeps DETAILS_PANEL_WIDTH in step with the aside it stands for", () => {
    expect(px(asideClass, "w")).toBe(DETAILS_PANEL_WIDTH);
  });
});
