// Fields a room (or any bot-initiated turn) must copy from the bot's
// picker selection. 1:1 chat already does this; a missing `model` is
// how Grok silently runs its cloud default.
import type { EffortLevel, ModelSelection } from "./contracts.ts";

export function memberTurnSelection(selection: ModelSelection, leanStartup?: boolean): {
  model: string;
  effort?: EffortLevel;
  leanStartup?: boolean;
} {
  return {
    model: selection.model,
    ...(selection.effort ? { effort: selection.effort } : {}),
    ...(leanStartup === true ? { leanStartup: true } : {}),
  };
}
