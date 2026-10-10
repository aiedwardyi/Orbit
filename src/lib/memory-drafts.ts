// Unsaved bot memory, one draft per bot, kept outside the editor so a closed
// or reopened panel shares it. Saves go out one at a time per bot and carry
// the revision their text was edited from: the server refuses a save that
// would overwrite memory changed elsewhere. The draft also sits in
// localStorage until a save of exactly that text lands, so a closed page
// keeps it.
import { z } from "zod";

import { holdReload } from "./reload-hold";

export interface MemoryLatest {
  text: string;
  revision: string;
}

/** What the open editor hears about its bot's saves. */
export interface MemoryView {
  saved(truncated: boolean, pending: boolean): void;
  failed(message: string, pending: boolean): void;
  conflict(latest: MemoryLatest): void;
}

const draftSchema = z.object({ text: z.string(), base: z.string().optional() });
const latestSchema = z.object({ text: z.string(), revision: z.string() });
type Draft = z.infer<typeof draftSchema>;

interface Slot {
  revision?: string;
  draft: Draft | null;
  sending: boolean;
  saves: number;
  // a refused save waits for Load latest or Keep mine
  held: boolean;
  pause: ReturnType<typeof setTimeout> | null;
  view: MemoryView | null;
}

const slots = new Map<string, Slot>();
const key = (botId: string) => `omb-memory-draft:${botId}`;

function readStored(botId: string): Draft | null {
  try {
    const parsed = draftSchema.safeParse(JSON.parse(localStorage.getItem(key(botId)) ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function slot(botId: string): Slot {
  let found = slots.get(botId);
  if (!found) {
    found = { draft: readStored(botId), sending: false, saves: 0, held: false, pause: null, view: null };
    slots.set(botId, found);
  }
  return found;
}

function setDraft(botId: string, draft: Draft | null): void {
  slot(botId).draft = draft;
  try {
    if (draft) localStorage.setItem(key(botId), JSON.stringify(draft));
    else localStorage.removeItem(key(botId));
  } catch {
    /* quota / private mode - the draft still lives for this page */
  }
}

export function memoryDraft(botId: string): string | null {
  return slot(botId).draft?.text ?? null;
}

/** Counts saves started, so a read sent before one can be told apart. */
export function memorySaves(botId: string): number {
  return slot(botId).saves;
}

export function watchMemory(botId: string, view: MemoryView | null): void {
  slot(botId).view = view;
}

/** Takes a fresh read. Returns the draft to show instead, if any, and whether it conflicts. */
export function openMemory(botId: string, latest: MemoryLatest): { text: string; conflict: boolean } | null {
  const s = slot(botId);
  s.revision = latest.revision;
  const draft = s.draft;
  if (draft && !s.sending && draft.text === latest.text) setDraft(botId, null);
  if (!s.draft) {
    s.held = false;
    return null;
  }
  // the save in flight settles this draft's base
  if (s.sending) return { text: s.draft.text, conflict: false };
  s.held = s.draft.base !== latest.revision;
  if (!s.held) void flushMemory(botId);
  return { text: s.draft.text, conflict: s.held };
}

export function editMemory(botId: string, text: string): void {
  const s = slot(botId);
  setDraft(botId, { text, base: s.draft ? s.draft.base : s.revision });
  if (s.held) return;
  if (s.pause !== null) clearTimeout(s.pause);
  s.pause = setTimeout(() => void flushMemory(botId), 800);
}

/** Keep mine: the draft goes over the newer file. */
export function keepMemory(botId: string, latest: MemoryLatest): void {
  const s = slot(botId);
  s.held = false;
  s.revision = latest.revision;
  if (s.draft) setDraft(botId, { text: s.draft.text, base: latest.revision });
  void flushMemory(botId);
}

/** Load latest: the draft is dropped. */
export function dropMemory(botId: string, latest: MemoryLatest): void {
  const s = slot(botId);
  s.held = false;
  s.revision = latest.revision;
  setDraft(botId, null);
}

export async function flushMemory(botId: string): Promise<void> {
  const s = slot(botId);
  if (s.pause !== null) clearTimeout(s.pause);
  s.pause = null;
  const sent = s.draft;
  // a save without a base would overwrite the file unchecked
  if (s.sending || s.held || !sent || sent.base === undefined) return;
  s.sending = true;
  s.saves++;
  const body = JSON.stringify({ text: sent.text, baseRevision: sent.base });
  try {
    const res = await holdReload(
      fetch(`/api/bots/${botId}/memory`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
        // keepalive outlives a closing page, but the browser rejects bodies over 64 KB
        keepalive: new TextEncoder().encode(body).length <= 64 * 1024,
      }),
    );
    const result = await res.json().catch(() => ({}));
    const latest = latestSchema.safeParse(result);
    if (res.status === 409 && latest.success) {
      s.held = true;
      s.revision = latest.data.revision;
      s.view?.conflict(latest.data);
    } else if (!res.ok) {
      throw new Error(result.error ?? `${res.status} ${res.statusText}`);
    } else {
      s.revision = result.revision;
      if (s.draft?.text === sent.text) {
        // another tab may have stored its own draft since
        if (readStored(botId)?.text === sent.text) setDraft(botId, null);
        else s.draft = null;
      } else if (s.draft) setDraft(botId, { text: s.draft.text, base: result.revision });
      s.view?.saved(result.truncated, s.draft !== null);
    }
  } catch (e) {
    s.view?.failed(e instanceof Error ? e.message : String(e), s.draft?.text !== sent.text);
  }
  s.sending = false;
  if (s.draft && s.draft.text !== sent.text && s.pause === null) void flushMemory(botId);
}
