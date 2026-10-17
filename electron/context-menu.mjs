// Native context menu template for the Electron window. Pure shape, so the
// read-only Copy case is pinned by a test without booting the app.
export function contextMenuTemplate(params, text, actions) {
  // nothing actionable here: no menu at all, rather than a wall of
  // disabled items
  if (!params.isEditable && !params.linkURL && !params.misspelledWord && !params.selectionText) return null;
  const menuItems = [];
  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      menuItems.push({
        label: suggestion,
        click: () => actions.replaceMisspelling(suggestion),
      });
    }
    if (menuItems.length) menuItems.push({ type: "separator" });
  }
  if (params.linkURL) {
    menuItems.push(
      { label: text("native.copyLink"), click: () => actions.copyLink(params.linkURL) },
      { type: "separator" },
    );
  }
  // a read-only selection outside the transcript gets Copy only: the full
  // wall would render mostly greyed out
  if (!params.isEditable && !params.linkURL && !params.misspelledWord) {
    menuItems.push({ label: text("native.copy"), role: "copy", enabled: params.editFlags.canCopy });
    return menuItems;
  }
  menuItems.push(
    { label: text("native.undo"), role: "undo", enabled: params.editFlags.canUndo },
    { label: text("native.redo"), role: "redo", enabled: params.editFlags.canRedo },
    { type: "separator" },
    { label: text("native.cut"), role: "cut", enabled: params.editFlags.canCut },
    { label: text("native.copy"), role: "copy", enabled: params.editFlags.canCopy },
    { label: text("native.paste"), role: "paste", enabled: params.editFlags.canPaste },
    { label: text("native.pasteMatch"), role: "pasteAndMatchStyle", enabled: params.editFlags.canPaste },
    { type: "separator" },
    { label: text("native.selectAll"), role: "selectAll", enabled: params.editFlags.canSelectAll },
  );
  return menuItems;
}

// Right-click on a local file link. A folder has nothing to copy, so no Save.
export function fileMenuTemplate({ directory }, text, actions) {
  return [
    { label: text("native.showInFolder"), click: actions.show },
    ...(directory ? [] : [{ label: text("native.saveCopy"), click: actions.save }]),
    { label: text("native.copyPath"), click: actions.copyPath },
  ];
}
