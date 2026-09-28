// The last chat snapshot this browser saw, kept for a reload.
//
// Phone browsers discard a backgrounded tab and reload it on return. Without
// this, the reload paints the full-screen connecting state until the stream
// says hello and every transcript downloads. The live snapshot always
// replaces it; nothing here is acted on.
import { redactSecrets } from "../../server/redact.ts";
import type { Bot, Group, InstanceInfo, Message } from "./store";

export interface CachedSnapshot {
  bots: Bot[];
  groups: Group[];
  selectedId: string;
  /** The model chip's engine icon; absent in older caches. */
  instances?: InstanceInfo[];
}

export const SNAPSHOT_CACHE_KEY = "omb-snapshot-v2";
/** Held user messages unredacted; dropped on the next read. */
const LEGACY_SNAPSHOT_CACHE_KEY = "omb-snapshot";

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
    const storage = store(explicit);
    storage?.removeItem(LEGACY_SNAPSHOT_CACHE_KEY);
    const raw = storage?.getItem(SNAPSHOT_CACHE_KEY);
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

// SAFETY: redactSecrets keeps the shape and only rewrites string values.
const redactMessages = (messages: Message[]) => messages.map((m) => redactSecrets(m) as Message);

export function writeSnapshotCache(snapshot: CachedSnapshot, explicit?: Storage): void {
  try {
    const redacted: CachedSnapshot = {
      ...snapshot,
      bots: snapshot.bots.map((b) => ({ ...b, messages: redactMessages(b.messages) })),
      groups: snapshot.groups.map((g) => ({ ...g, messages: redactMessages(g.messages) })),
    };
    store(explicit)?.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(redacted));
  } catch {
    /* over quota or blocked: a reload just shows the connecting screen */
  }
}
