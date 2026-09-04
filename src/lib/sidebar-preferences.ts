export type SidebarDensity = "comfortable" | "compact" | "icons";

export type SidebarLayout = {
  collapsed: boolean;
  width: number;
};

export const SIDEBAR_DENSITY_KEY = "openmausbot.sidebarDensity";
export const SIDEBAR_WIDTH_KEY = "openmausbot.sidebarWidth";
export const SIDEBAR_COLLAPSED_KEY = "openmausbot.sidebarCollapsed";
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 320;
export const SIDEBAR_ICONS_WIDTH = 80;
export const SIDEBAR_COLLAPSED_WIDTH = 64;
export const SIDEBAR_SNAP_DISTANCE = 24;
export const SIDEBAR_WIDTH_STEP = 10;

export function parseSidebarDensity(value: string | null): SidebarDensity {
  switch (value) {
    case "comfortable":
    case "compact":
    case "icons":
      return value;
    default:
      return "comfortable";
  }
}

export function loadSidebarDensity(storage?: Pick<Storage, "getItem"> | null): SidebarDensity {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseSidebarDensity(target?.getItem(SIDEBAR_DENSITY_KEY) ?? null);
  } catch {
    return "comfortable";
  }
}

export function saveSidebarDensity(
  density: SidebarDensity,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_DENSITY_KEY, density);
  } catch {
    // Private browsing and locked-down webviews may reject localStorage.
    // The in-memory React state still makes the control useful this session.
  }
}

export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

export function displaySidebarWidth(layout: SidebarLayout): number {
  return layout.collapsed ? SIDEBAR_COLLAPSED_WIDTH : layout.width;
}

export function snapSidebarDrag(drag: SidebarLayout, deltaX: number): SidebarLayout {
  if (drag.collapsed) {
    if (deltaX >= SIDEBAR_SNAP_DISTANCE) return { collapsed: false, width: drag.width };
    return { collapsed: true, width: drag.width };
  }
  const proposed = drag.width + deltaX;
  if (proposed <= SIDEBAR_MIN_WIDTH - SIDEBAR_SNAP_DISTANCE) {
    return { collapsed: true, width: drag.width };
  }
  return { collapsed: false, width: clampSidebarWidth(proposed) };
}

export function stepSidebarWidth(current: number, key: string): number | null {
  if (key === "Home") return SIDEBAR_MIN_WIDTH;
  if (key === "End") return SIDEBAR_MAX_WIDTH;
  const delta = key === "ArrowRight" ? SIDEBAR_WIDTH_STEP : key === "ArrowLeft" ? -SIDEBAR_WIDTH_STEP : 0;
  if (delta === 0) return null;
  return clampSidebarWidth(current + delta);
}

export function stepSidebarLayout(layout: SidebarLayout, key: string): SidebarLayout | null {
  let next: SidebarLayout;
  if (key === "Home") next = { collapsed: true, width: layout.width };
  else if (key === "End") next = { collapsed: false, width: SIDEBAR_MAX_WIDTH };
  else if (key === "ArrowLeft") {
    if (layout.collapsed) return null;
    next = layout.width <= SIDEBAR_MIN_WIDTH
      ? { collapsed: true, width: layout.width }
      : { collapsed: false, width: clampSidebarWidth(layout.width - SIDEBAR_WIDTH_STEP) };
  } else if (key === "ArrowRight") {
    next = layout.collapsed
      ? { collapsed: false, width: layout.width }
      : { collapsed: false, width: clampSidebarWidth(layout.width + SIDEBAR_WIDTH_STEP) };
  } else {
    return null;
  }
  if (next.collapsed === layout.collapsed && next.width === layout.width) return null;
  return next;
}

export function restoreSidebarDragWidth(drag: SidebarLayout | null): SidebarLayout | null {
  return drag ? { width: drag.width, collapsed: drag.collapsed } : null;
}

export function parseSidebarWidth(value: string | null): number {
  if (value == null || value.trim() === "") return SIDEBAR_DEFAULT_WIDTH;
  return clampSidebarWidth(Number(value));
}

export function parseSidebarCollapsed(value: string | null): boolean {
  return value === "1" || value === "true";
}

export function loadSidebarWidth(storage?: Pick<Storage, "getItem"> | null): number {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseSidebarWidth(target?.getItem(SIDEBAR_WIDTH_KEY) ?? null);
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function saveSidebarWidth(
  width: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
  } catch {
    // Same localStorage failure mode as density — width still applies this session.
  }
}

export function loadSidebarCollapsed(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseSidebarCollapsed(target?.getItem(SIDEBAR_COLLAPSED_KEY) ?? null);
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(
  collapsed: boolean,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Same localStorage failure mode as width — collapse still applies this session.
  }
}
