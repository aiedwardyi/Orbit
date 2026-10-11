import type { RuntimeEvent } from "./contracts.ts";
import type { Message } from "./store.ts";

export function completedTool(
  existing: Message["tool"],
  event: Extract<RuntimeEvent, { type: "item.completed"; itemType: "tool" }>,
): NonNullable<Message["tool"]> {
  const summary = event.summary ?? existing?.summary;
  return {
    name: existing?.name ?? "tool",
    ok: event.ok,
    spoken: existing?.spoken,
    ...(summary ? { summary } : {}),
    ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
    ...(event.detail ? { detail: event.detail } : {}),
  };
}
