import { describe, expect, it, vi } from "vitest";

import { contextMenuTemplate, fileMenuTemplate, imageMenuTemplate } from "./context-menu.mjs";

const text = (key) => key;
const actions = { replaceMisspelling: vi.fn(), copyLink: vi.fn(), copyImage: vi.fn(), saveImage: vi.fn() };
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

describe("image menu", () => {
  const imageParams = (overrides = {}) => ({
    ...editable(),
    mediaType: "image",
    srcURL: "http://127.0.0.1:8799/api/attachments/shot.png",
    x: 30,
    y: 40,
    ...overrides,
  });

  it("offers copy and save for an image with nothing else actionable", () => {
    const template = contextMenuTemplate(imageParams(), text, actions);
    expect(template.map((item) => item.label)).toEqual(["native.copyImage", "native.saveImage"]);
  });

  it("keeps the image menu when a selection or link rides along", () => {
    for (const extra of [{ selectionText: "caption words" }, { linkURL: "https://example.com/shot.png" }]) {
      const template = contextMenuTemplate(imageParams(extra), text, actions);
      expect(template.map((item) => item.label)).toEqual(["native.copyImage", "native.saveImage"]);
    }
  });

  it("copies and saves through the image actions", () => {
    const template = imageMenuTemplate(text, actions);
    template[0].click();
    template[1].click();
    expect(actions.copyImage).toHaveBeenCalledTimes(1);
    expect(actions.saveImage).toHaveBeenCalledTimes(1);
  });
});

describe("file link menu", () => {
  const labels = (items) => items.map((item) => item.label);

  it("lists show, save and copy for a file", () => {
    const template = fileMenuTemplate({ directory: false }, text, { show: vi.fn(), save: vi.fn(), copyPath: vi.fn() });
    expect(labels(template)).toEqual(["native.showInFolder", "native.saveCopy", "native.copyPath"]);
  });

  it("leaves Save out for a folder", () => {
    const template = fileMenuTemplate({ directory: true }, text, { show: vi.fn(), save: vi.fn(), copyPath: vi.fn() });
    expect(labels(template)).toEqual(["native.showInFolder", "native.copyPath"]);
  });
});
