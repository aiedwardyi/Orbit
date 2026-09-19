import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TRANSCRIPT_GAP, fitComposerHeight, transcriptEndPad } from "./composer-dock";

const here = dirname(fileURLToPath(import.meta.url));
const chatView = readFileSync(join(here, "../components/ChatView.tsx"), "utf8");
const groupView = readFileSync(join(here, "../components/GroupView.tsx"), "utf8");

describe("transcriptEndPad", () => {
  it("adds one gap-3 of black above the measured composer", () => {
    expect(TRANSCRIPT_GAP).toBe("0.75rem");
    expect(transcriptEndPad(72)).toBe("calc(72px + 0.75rem)");
  });

  it("ceils fractional heights so a subpixel composer cannot eat the gap", () => {
    expect(transcriptEndPad(71.2)).toBe("calc(72px + 0.75rem)");
  });

  it("does not go negative", () => {
    expect(transcriptEndPad(-4)).toBe("calc(0px + 0.75rem)");
  });
});

const WINDOW_FLOOR = { width: 600, height: 480 };

type Box = { x: number; y: number; w: number; h: number };

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function overlayDockClass(source: string): string {
  const match = source.match(/composerDockRef\} className=\{cn\("([^"]*)"/);
  if (!match) throw new Error("missing composer dock class");
  return match[1];
}

/** 600x480 short-thread geometry. Overlay chrome is continuity or usage. */
function layoutFloorOverlay(dockClass: string, overlayH: number): {
  overlay: Box;
  composer: Box;
  lastMessage: Box;
} {
  const w = WINDOW_FLOOR.width;
  const h = WINDOW_FLOOR.height;
  const composerH = 96;
  const lastH = 72;
  if (dockClass.includes("absolute") && dockClass.includes("bottom-0")) {
    const composer: Box = { x: 0, y: h - composerH, w, h: composerH };
    return {
      overlay: { x: 0, y: composer.y - overlayH, w, h: overlayH },
      composer,
      lastMessage: { x: 0, y: 300, w, h: lastH },
    };
  }
  const dockH = overlayH + composerH;
  const transcriptBottom = h - dockH;
  return {
    overlay: { x: 0, y: transcriptBottom, w, h: overlayH },
    composer: { x: 0, y: transcriptBottom + overlayH, w, h: composerH },
    lastMessage: { x: 0, y: transcriptBottom - lastH, w, h: lastH },
  };
}

describe("window floor overlay layer", () => {
  it("at 600x480 the overlay layer does not occlude the composer or clip chat text", () => {
    for (const source of [chatView, groupView]) {
      const dockClass = overlayDockClass(source);
      // Continuity strip (~56px) and usage meter (~28px) share the layer.
      for (const overlayH of [56, 28]) {
        const { overlay, composer, lastMessage } = layoutFloorOverlay(dockClass, overlayH);
        expect(boxesOverlap(overlay, composer)).toBe(false);
        expect(boxesOverlap(overlay, lastMessage)).toBe(false);
        expect(boxesOverlap(composer, lastMessage)).toBe(false);
      }
    }
  });
});

describe("fitComposerHeight", () => {
  // Frame = textarea + 16px chrome, unless its height is pinned inline.
  function composerModel(contentPx: number, renderedPx: number) {
    const readFrameHeights: number[] = [];
    const frame = { style: { height: "" }, getBoundingClientRect: () => ({ height: frameHeight() }) };
    const textarea = {
      parentElement: frame,
      style: { height: `${renderedPx}px` },
      get scrollHeight() {
        readFrameHeights.push(frameHeight());
        return contentPx;
      },
    };
    function frameHeight(): number {
      if (frame.style.height) return parseFloat(frame.style.height);
      const own = textarea.style.height === "auto" ? 32 : parseFloat(textarea.style.height);
      return own + 16;
    }
    return { textarea, frameHeight, readFrameHeights };
  }

  it("never collapses the dock while measuring a multi-line draft", () => {
    const { textarea, frameHeight, readFrameHeights } = composerModel(80, 80);
    fitComposerHeight(textarea, 24);
    expect(readFrameHeights).toEqual([96]);
    expect(textarea.style.height).toBe("80px");
    expect(frameHeight()).toBe(96);
  });

  it("still grows and shrinks with the draft, capped at six lines", () => {
    const grow = composerModel(80, 32);
    fitComposerHeight(grow.textarea, 24);
    expect(grow.textarea.style.height).toBe("80px");
    expect(grow.frameHeight()).toBe(96);

    const shrink = composerModel(32, 80);
    fitComposerHeight(shrink.textarea, 24);
    expect(shrink.textarea.style.height).toBe("32px");

    const cap = composerModel(400, 144);
    fitComposerHeight(cap.textarea, 24);
    expect(cap.textarea.style.height).toBe("144px");
  });
});
