import "@/components/ProfileFields.test-dom.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  focusComposer,
  focusComposerOnActivation,
  isDialogActive,
  isSearchActive,
  isSettingsActive,
  isSidebarNavigationActive,
  isTerminalActive,
  shouldFocusComposerOnTranscriptClick,
} from "./focus-composer";

describe("focusComposer", () => {
  let textarea: HTMLTextAreaElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    textarea = document.createElement("textarea");
    textarea.setAttribute("data-orbit-composer", "");
    textarea.value = "saved draft text";
    document.body.append(textarea);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("focuses composer and preserves draft text and cursor position", () => {
    textarea.setSelectionRange(5, 5);
    const focused = focusComposer(document);

    expect(focused).toBe(true);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe("saved draft text");
    expect(textarea.selectionStart).toBe(5);
    expect(textarea.selectionEnd).toBe(5);
  });

  it("preserves selection range when focusing", () => {
    textarea.setSelectionRange(2, 8);
    focusComposer(document);

    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(8);
  });

  it("focuses the requested active composer when several are mounted", () => {
    const roomComposer = document.createElement("textarea");
    roomComposer.setAttribute("data-orbit-composer", "");
    roomComposer.value = "room draft";
    roomComposer.setSelectionRange(2, 6);
    const scrollIntoView = vi.fn();
    roomComposer.scrollIntoView = scrollIntoView;
    document.body.append(roomComposer);

    expect(focusComposer(document, roomComposer)).toBe(true);
    expect(document.activeElement).toBe(roomComposer);
    expect(roomComposer.selectionStart).toBe(2);
    expect(roomComposer.selectionEnd).toBe(6);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("undoes horizontal drift scrollIntoView leaves on an ancestor", () => {
    const root = document.createElement("div");
    document.body.append(root);
    root.append(textarea);
    // simulates scrollIntoView scrolling an overflow:hidden ancestor (e.g. #root) sideways
    textarea.scrollIntoView = () => {
      root.scrollLeft = 140;
    };

    focusComposer(document);

    expect(root.scrollLeft).toBe(0);
  });
});

describe("focusComposerOnActivation guards", () => {
  let textarea: HTMLTextAreaElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    textarea = document.createElement("textarea");
    textarea.setAttribute("data-orbit-composer", "");
    textarea.value = "draft text";
    document.body.append(textarea);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "ogb");
  });

  it("focuses on next render tick when activated", async () => {
    const row = document.createElement("div");
    document.body.append(row);
    row.focus();

    focusComposerOnActivation({ activatedElement: row, targetDocument: document });
    expect(document.activeElement).not.toBe(textarea);

    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(textarea);
  });

  it("leaves mobile activation unfocused until the input is tapped", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query === "(pointer: coarse)" }) as MediaQueryList);

    focusComposerOnActivation({ targetDocument: document });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.activeElement).not.toBe(textarea);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
  });

  it("keeps native desktop activation on a touch screen", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query === "(pointer: coarse)" }) as MediaQueryList);
    Object.defineProperty(window, "ogb", { configurable: true, value: {} });

    focusComposerOnActivation({ targetDocument: document });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.activeElement).toBe(textarea);
  });

  it("rechecks mobile input before a scheduled activation", async () => {
    let touch = false;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: touch && query === "(pointer: coarse)" }) as MediaQueryList);
    focusComposerOnActivation({ targetDocument: document });
    touch = true;
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.activeElement).not.toBe(textarea);
  });

  it("never steals focus from search input", async () => {
    const search = document.createElement("input");
    search.setAttribute("type", "search");
    search.setAttribute("aria-label", "Search bots");
    document.body.append(search);
    search.focus();

    expect(isSearchActive(document)).toBe(true);
    focusComposerOnActivation({ targetDocument: document });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.activeElement).toBe(search);
    expect(document.activeElement).not.toBe(textarea);
  });

  it("never steals focus from search results", async () => {
    const results = document.createElement("div");
    results.setAttribute("data-search-results", "");
    const button = document.createElement("button");
    results.append(button);
    document.body.append(results);
    button.focus();

    expect(isSearchActive(document)).toBe(true);
    focusComposerOnActivation({ targetDocument: document });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.activeElement).toBe(button);
    expect(document.activeElement).not.toBe(textarea);
  });

  it("never steals focus from sidebar navigation", async () => {
    const sidebar = document.createElement("aside");
    const row1 = document.createElement("div");
    const row2 = document.createElement("div");
    sidebar.append(row1, row2);
    document.body.append(sidebar);

    row2.focus();
    expect(isSidebarNavigationActive(document, row1)).toBe(true);

    focusComposerOnActivation({ activatedElement: row1, targetDocument: document });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.activeElement).toBe(row2);
    expect(document.activeElement).not.toBe(textarea);
  });

  it("never steals focus from sidebar rename input", async () => {
    const sidebar = document.createElement("aside");
    const row = document.createElement("div");
    const renameInput = document.createElement("input");
    row.append(renameInput);
    sidebar.append(row);
    document.body.append(sidebar);

    renameInput.focus();
    expect(isSidebarNavigationActive(document, row)).toBe(true);

    focusComposerOnActivation({ activatedElement: row, targetDocument: document });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.activeElement).toBe(renameInput);
    expect(document.activeElement).not.toBe(textarea);
  });

  it("never steals focus from terminal mode", async () => {
    const terminal = document.createElement("div");
    terminal.className = "orbit-terminal-overlay";
    terminal.setAttribute("data-open", "true");
    document.body.append(terminal);

    expect(isTerminalActive(document)).toBe(true);
    focusComposerOnActivation({ targetDocument: document });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.activeElement).not.toBe(textarea);
  });

  it("never steals focus from dialogs", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);

    expect(isDialogActive(document)).toBe(true);
    focusComposerOnActivation({ targetDocument: document });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.activeElement).not.toBe(textarea);
  });

  it("never steals focus from settings", async () => {
    const settings = document.createElement("aside");
    settings.setAttribute("data-settings-panel", "");
    document.body.append(settings);

    expect(isSettingsActive(document)).toBe(true);
    focusComposerOnActivation({ targetDocument: document });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.activeElement).not.toBe(textarea);
  });

  it("focuses the requested composer after activation", async () => {
    const roomComposer = document.createElement("textarea");
    roomComposer.setAttribute("data-orbit-composer", "");
    roomComposer.value = "room draft";
    roomComposer.setSelectionRange(4, 4);
    document.body.append(roomComposer);

    focusComposerOnActivation({ composer: roomComposer, targetDocument: document });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(document.activeElement).toBe(roomComposer);
    expect(roomComposer.selectionStart).toBe(4);
    expect(roomComposer.selectionEnd).toBe(4);
  });
});

describe("shouldFocusComposerOnTranscriptClick", () => {
  const plainClick = () => ({ button: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("focuses on an empty-space click", () => {
    const space = document.createElement("div");
    document.body.append(space);

    expect(shouldFocusComposerOnTranscriptClick(space, plainClick(), true)).toBe(true);
  });

  it("ignores mobile taps beside messages", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query === "(pointer: coarse)" }) as MediaQueryList);
    const space = document.createElement("div");
    document.body.append(space);

    expect(shouldFocusComposerOnTranscriptClick(space, plainClick(), true)).toBe(false);
  });

  const messageRow = () => {
    const row = document.createElement("div");
    row.setAttribute("data-orbit-message", "bot");
    row.tabIndex = -1;
    const bubble = document.createElement("div");
    bubble.setAttribute("data-orbit-message-content", "");
    const text = document.createElement("span");
    bubble.append(text);
    row.append(bubble);
    document.body.append(row);
    return { row, text };
  };

  it("ignores clicks inside a message bubble", () => {
    const { text } = messageRow();

    expect(shouldFocusComposerOnTranscriptClick(text, plainClick(), true)).toBe(false);
  });

  it("focuses on a click beside a message bubble", () => {
    const { row } = messageRow();

    expect(shouldFocusComposerOnTranscriptClick(row, plainClick(), true)).toBe(true);
  });

  it("ignores clicks on focusable widgets", () => {
    const widget = document.createElement("div");
    widget.tabIndex = 0;
    document.body.append(widget);

    expect(shouldFocusComposerOnTranscriptClick(widget, plainClick(), true)).toBe(false);
  });

  it("ignores clicks on links", () => {
    const link = document.createElement("a");
    link.setAttribute("href", "https://example.com");
    document.body.append(link);

    expect(shouldFocusComposerOnTranscriptClick(link, plainClick(), true)).toBe(false);
  });

  it("ignores clicks on buttons", () => {
    const button = document.createElement("button");
    document.body.append(button);

    expect(shouldFocusComposerOnTranscriptClick(button, plainClick(), true)).toBe(false);
  });

  it("ignores clicks inside code blocks", () => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    pre.append(code);
    document.body.append(pre);

    expect(shouldFocusComposerOnTranscriptClick(code, plainClick(), true)).toBe(false);
  });

  it("ignores clicks while a text selection is open", () => {
    const space = document.createElement("div");
    document.body.append(space);

    expect(shouldFocusComposerOnTranscriptClick(space, plainClick(), false)).toBe(false);
  });

  it("ignores modified clicks", () => {
    const space = document.createElement("div");
    document.body.append(space);

    expect(shouldFocusComposerOnTranscriptClick(space, { ...plainClick(), shiftKey: true }, true)).toBe(false);
  });

  it("ignores targets outside the transcript container, like a portalled picker", () => {
    const transcript = document.createElement("div");
    const space = document.createElement("div");
    transcript.append(space);
    const picker = document.createElement("div");
    picker.setAttribute("data-reaction-picker", "");
    document.body.append(transcript, picker);

    expect(shouldFocusComposerOnTranscriptClick(space, plainClick(), true, transcript)).toBe(true);
    expect(shouldFocusComposerOnTranscriptClick(picker, plainClick(), true, transcript)).toBe(false);
  });

  it("ignores right clicks", () => {
    const space = document.createElement("div");
    document.body.append(space);

    expect(shouldFocusComposerOnTranscriptClick(space, { ...plainClick(), button: 2 }, true)).toBe(false);
  });
});
