import type { ModelSelection } from "../server/contracts.ts";

// Explicit, never an allowlist: unknown kinds keep their old behavior.
const RETIRED_ENGINE_KINDS = new Map([
  ["grok", "Grok (API)"], ["geminiAgent", "Gemini API"], ["kimiAgent", "Kimi"], ["droidAgent", "Droid"],
  ["cursorAgent", "Cursor"], ["qwenAgent", "Qwen"], ["hermesAgent", "Hermes"],
  ["openai-compat", "OpenAI-compatible (OpenRouter / Groq)"], ["piAgent", "pi"],
  ["minimax", "MiniMax (API)"], ["opencodeGo", "OpenCode"],
]);

export function isRetiredEngineKind(kind?: string): boolean {
  return kind !== undefined && RETIRED_ENGINE_KINDS.has(kind);
}

export function retiredEngineLabel(kind: string): string | undefined {
  return RETIRED_ENGINE_KINDS.get(kind);
}

export function sameModelSelection(a: ModelSelection, b: ModelSelection): boolean {
  return (
    a.instanceId === b.instanceId &&
    a.model === b.model &&
    (a.mode ?? "pinned") === (b.mode ?? "pinned") &&
    a.effort === b.effort
  );
}
