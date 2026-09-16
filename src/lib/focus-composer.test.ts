import "@/components/ProfileFields.test-dom.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  focusComposer,
  focusComposerOnActivation,
  isDialogActive,
  isSearchActive,
  isSettingsActive,
  isSidebarNavigationActive,
  isTerminalActive,
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
});
