import type { BotUpdatePatch } from "./bot-patch-queue";

export type BotProfileField = "name" | "title" | "description";
type Save = "saving" | number;

const fields: BotProfileField[] = ["name", "title", "description"];
const saves = new Map<string, Partial<Record<BotProfileField, Save>>>();
const listeners = new Map<string, Set<() => void>>();

export function botPatchStatus(botId: string, field: BotProfileField): Save | null {
  return saves.get(botId)?.[field] ?? null;
}

export function watchBotPatchStatus(botId: string, changed: () => void): () => void {
  const views = listeners.get(botId) ?? new Set();
  listeners.set(botId, views);
  views.add(changed);
  return () => {
    views.delete(changed);
    if (views.size === 0) listeners.delete(botId);
  };
}

export function setBotPatchStatus(botId: string, patch: BotUpdatePatch, status: "saving" | "saved" | "idle", pending: BotUpdatePatch = {}): void {
  const current = saves.get(botId) ?? {};
  const value = status === "saved" ? Date.now() : status;
  let changed = false;
  for (const field of fields) {
    if (!Object.hasOwn(patch, field) || Object.hasOwn(pending, field)) continue;
    if (value === "idle") delete current[field];
    else current[field] = value;
    changed = true;
  }
  if (!changed) return;
  if (Object.keys(current).length) saves.set(botId, current);
  else saves.delete(botId);
  for (const view of listeners.get(botId) ?? []) view();
}
