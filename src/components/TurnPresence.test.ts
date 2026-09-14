import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageBoundary, PresenceAnswer, TurnPresence } from "./TurnPresence";

function presence(text: string | null, settled: boolean) {
  return renderToStaticMarkup(
    createElement(
      TurnPresence,
      {
        avatar: null,
        visible: true,
        label: "Responding",
        answering: settled,
        streaming: !settled && text !== null,
      },
      text
        ? createElement(MessageBoundary, { fallbackText: text, children: createElement(PresenceAnswer, { text }) })
        : null,
    ),
  );
}

describe("presence answer streaming", () => {
  it("paints live partial text above the still-shimmering wait label", () => {
    const markup = presence("Shoelaces were patented in 1790", false);
    expect(markup).toContain("Shoelaces were patented in 1790");
    expect(markup).toContain("turn-answer");
    expect(markup).toContain("Responding");
  });

  it("paints settled pop-in text while the label yields", () => {
    const markup = presence("The complete reply.", true);
    expect(markup).toContain("The complete reply.");
    expect(markup).not.toContain("Responding");
  });

  it("renders no bubble until the first text arrives", () => {
    expect(renderToStaticMarkup(createElement(PresenceAnswer, { text: null }))).toBe("");
    expect(presence(null, false)).not.toContain("turn-answer");
  });

  it("keeps the wait label while no text has arrived", () => {
    expect(presence(null, false)).toContain("Responding");
  });
});
