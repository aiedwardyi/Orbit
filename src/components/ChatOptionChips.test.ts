import "@/components/ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ChatOptionChips } from "./ChatOptionChips";
import { applyLocale } from "@/lib/i18n";
import { focusComposerOnActivation } from "@/lib/focus-composer";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  document.body.querySelectorAll("[data-orbit-composer]").forEach((element) => element.remove());
  root = null;
  host = null;
});

function addComposer(value: string) {
  const composer = document.createElement("textarea");
  composer.setAttribute("data-orbit-composer", "");
  composer.value = value;
  composer.setSelectionRange(2, 5);
  document.body.append(composer);
  return composer;
}

async function clickWriteOwn(onWriteOwn: () => void) {
  applyLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(ChatOptionChips, {
        options: ["one", "two"],
        onPick: () => {},
        onWriteOwn,
      }),
    );
  });
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Write my own"));
  if (!button) throw new Error("write-own button did not render");
  await act(async () => {
    button.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

describe("ChatOptionChips free-answer focus", () => {
  it.each([
    ["direct chat", "direct draft"],
    ["room", "room draft"],
  ])("focuses the active %s composer", async (_label, activeDraft) => {
    const directComposer = addComposer("direct draft");
    const roomComposer = addComposer("room draft");
    const activeComposer = activeDraft === directComposer.value ? directComposer : roomComposer;
    activeComposer.scrollIntoView = () => undefined;

    await clickWriteOwn(() =>
      focusComposerOnActivation({ composer: activeComposer, targetDocument: document }),
    );

    expect(document.activeElement).toBe(activeComposer);
    expect(activeComposer.value).toBe(activeDraft);
    expect(activeComposer.selectionStart).toBe(2);
    expect(activeComposer.selectionEnd).toBe(5);
  });
});
