// The last chat snapshot this browser saw, kept for a reload.
//
// Phone browsers discard a backgrounded tab and reload it on return. Without
// this, the reload paints the full-screen connecting state until the stream
// says hello and every transcript downloads. The live snapshot always
// replaces it; nothing here is acted on.
import type { Bot, Group, InstanceInfo } from "./store";

export interface CachedSnapshot {
  bots: Bot[];
  groups: Group[];
  selectedId: string;
  /** The model chip's engine icon; absent in older caches. */
  instances?: InstanceInfo[];
}

export const SNAPSHOT_CACHE_KEY = "omb-snapshot";

/** A private window or blocked site data throws on access. */
function store(explicit?: Storage): Storage | undefined {
  if (explicit) return explicit;
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isConversation = (value: unknown) =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.threadId === "string" &&
  Array.isArray(value.messages);

const isInstance = (value: unknown) =>
  isRecord(value) && typeof value.instanceId === "string" && typeof value.driverKind === "string";

export function readSnapshotCache(explicit?: Storage): CachedSnapshot | null {
  try {
    const raw = store(explicit)?.getItem(SNAPSHOT_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      !Array.isArray(parsed.bots) ||
      !Array.isArray(parsed.groups) ||
      typeof parsed.selectedId !== "string" ||
      !parsed.bots.every(isConversation) ||
      !parsed.groups.every(isConversation) ||
      (parsed.instances !== undefined && !(Array.isArray(parsed.instances) && parsed.instances.every(isInstance)))
    ) {
      return null;
    }
    // SAFETY: shape checked above; the next hydrate replaces every field.
    return parsed as unknown as CachedSnapshot;
  } catch {
    return null;
  }
}

export function writeSnapshotCache(snapshot: CachedSnapshot, explicit?: Storage): void {
  try {
    store(explicit)?.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    /* over quota or blocked: a reload just shows the connecting screen */
  }
}
