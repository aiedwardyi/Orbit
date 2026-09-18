export interface FocusComposerOptions {
  activatedElement?: Element | null;
  targetDocument?: Document;
  settingsOpen?: boolean;
  terminalOpen?: boolean;
}

export function isSearchActive(doc: Document): boolean {
  const active = doc.activeElement;
  if (!active || active === doc.body) return false;
  if (active.closest('[role="search"], [data-search-results], [data-chat-find], [data-command-palette]')) {
    return true;
  }
  if (active instanceof (doc.defaultView?.HTMLInputElement ?? HTMLInputElement)) {
    const type = active.type.toLowerCase();
    const label = active.getAttribute("aria-label")?.toLowerCase() ?? "";
    const placeholder = active.getAttribute("placeholder")?.toLowerCase() ?? "";
    if (type === "search" || label.includes("search") || placeholder.includes("search")) {
      return true;
    }
  }
  return false;
}

export function isDialogActive(doc: Document): boolean {
  const active = doc.activeElement;
  if (active?.closest('[role="dialog"], [aria-modal="true"]')) return true;
  if (doc.querySelector('[role="dialog"], [aria-modal="true"], dialog[open]')) return true;
  return false;
}

export function isSettingsActive(doc: Document, settingsOpen = false): boolean {
  if (settingsOpen) return true;
  const active = doc.activeElement;
  if (active?.closest('[data-settings-panel], [data-settings-modal], aside[aria-label*="settings" i]')) return true;
  if (doc.querySelector('[data-settings-panel], [data-settings-modal], aside[aria-label*="settings" i]')) return true;
  return false;
}

export function isTerminalActive(doc: Document, terminalOpen = false): boolean {
  if (terminalOpen) return true;
  const active = doc.activeElement;
  if (active?.closest('.orbit-terminal-overlay, [data-terminal]')) return true;
  if (doc.querySelector('.orbit-terminal-overlay[data-open="true"]')) return true;
  return false;
}

export function isSidebarNavigationActive(doc: Document, activatedElement?: Element | null): boolean {
  const active = doc.activeElement;
  if (!active || active === doc.body) return false;
  const sidebar = active.closest("aside, nav, [data-sidebar]");
  if (!sidebar) return false;
  if (activatedElement && active !== activatedElement && !activatedElement.contains(active)) {
    return true;
  }
  if (active.matches('input, textarea, [contenteditable="true"]')) {
    return true;
  }
  return false;
}

export function focusComposer(doc: Document = document): boolean {
  const composers = [...doc.querySelectorAll<HTMLTextAreaElement>("[data-orbit-composer]:not(:disabled)")];
  const composer = composers.find((candidate) => candidate.getClientRects().length > 0) ?? composers[0];
  if (!composer) return false;
  if (doc.activeElement === composer) return true;

  const start = composer.selectionStart;
  const end = composer.selectionEnd;
  composer.focus();
  if (typeof start === "number" && typeof end === "number") {
    composer.setSelectionRange(start, end);
  }
  composer.scrollIntoView?.({ block: "nearest" });
  return true;
}

let scheduledFrame: number | null = null;

export function focusComposerOnActivation(options: FocusComposerOptions = {}): void {
  const doc = options.targetDocument ?? (typeof document !== "undefined" ? document : null);
  if (!doc) return;

  const raf = doc.defaultView?.requestAnimationFrame ?? (typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : null);
  const caf = doc.defaultView?.cancelAnimationFrame ?? (typeof cancelAnimationFrame !== "undefined" ? cancelAnimationFrame : null);
  if (typeof raf !== "function") return;

  if (scheduledFrame !== null && typeof caf === "function") {
    caf(scheduledFrame);
    scheduledFrame = null;
  }

  scheduledFrame = raf(() => {
    scheduledFrame = null;
    if (isDialogActive(doc)) return;
    if (isSettingsActive(doc, options.settingsOpen)) return;
    if (isTerminalActive(doc, options.terminalOpen)) return;
    if (isSearchActive(doc)) return;
    if (isSidebarNavigationActive(doc, options.activatedElement)) return;

    focusComposer(doc);
  });
}
