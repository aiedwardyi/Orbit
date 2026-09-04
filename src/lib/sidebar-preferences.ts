export type SidebarDensity = "comfortable" | "compact" | "icons";

export const SIDEBAR_DENSITY_KEY = "openmausbot.sidebarDensity";
export const SIDEBAR_WIDTH_KEY = "openmausbot.sidebarWidth";
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 320;
export const SIDEBAR_ICONS_WIDTH = 80;
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

export function stepSidebarWidth(current: number, key: string): number | null {
  if (key === "Home") return SIDEBAR_MIN_WIDTH;
  if (key === "End") return SIDEBAR_MAX_WIDTH;
  const delta = key === "ArrowRight" ? SIDEBAR_WIDTH_STEP : key === "ArrowLeft" ? -SIDEBAR_WIDTH_STEP : 0;
  if (delta === 0) return null;
  return clampSidebarWidth(current + delta);
}

export function parseSidebarWidth(value: string | null): number {
  if (value == null || value.trim() === "") return SIDEBAR_DEFAULT_WIDTH;
  return clampSidebarWidth(Number(value));
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
