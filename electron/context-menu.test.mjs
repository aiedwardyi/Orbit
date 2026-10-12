import { describe, expect, it, vi } from "vitest";

import { contextMenuTemplate } from "./context-menu.mjs";

const text = (key) => key;
const actions = { replaceMisspelling: vi.fn(), copyLink: vi.fn() };
const editable = (overrides = {}) => ({
  isEditable: false, linkURL: "", misspelledWord: "", selectionText: "",
  dictionarySuggestions: [], editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
  ...overrides,
});

describe("native context menu", () => {
  it("shows nothing when nothing is actionable", () => {
    expect(contextMenuTemplate(editable(), text, actions)).toBeNull();
  });

  it("shows Copy only for a read-only selection", () => {
    const template = contextMenuTemplate(editable({ selectionText: "transcript words" }), text, actions);
    expect(template).toHaveLength(1);
    expect(template[0]).toMatchObject({ label: "native.copy", role: "copy", enabled: true });
  });

  it("keeps the full menu in editable fields", () => {
    const template = contextMenuTemplate(
      editable({ isEditable: true, selectionText: "draft", editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } }),
      text, actions,
    );
    expect(template.map((item) => item.role ?? item.type)).toEqual([
      "undo", "redo", "separator", "cut", "copy", "paste", "pasteAndMatchStyle", "separator", "selectAll",
    ]);
  });

  it("keeps the link menu unchanged", () => {
    const template = contextMenuTemplate(editable({ linkURL: "https://example.com" }), text, actions);
    expect(template[0]).toMatchObject({ label: "native.copyLink" });
    expect(template.map((item) => item.role ?? item.label ?? item.type)).toContain("selectAll");
    template[0].click();
    expect(actions.copyLink).toHaveBeenCalledWith("https://example.com");
  });

  it("keeps spelling suggestions unchanged", () => {
    const template = contextMenuTemplate(
      editable({ isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "tea"] }),
      text, actions,
    );
    expect(template[0]).toMatchObject({ label: "the" });
    expect(template[1]).toMatchObject({ label: "tea" });
    expect(template[2]).toMatchObject({ type: "separator" });
    template[0].click();
    expect(actions.replaceMisspelling).toHaveBeenCalledWith("the");
  });
});
