// A model picked mid-reply waits for the turn to end: stop, approvals and
// steers must keep reaching the engine that is running it.
import type { ModelSelection } from "./contracts.ts";
import { sameModelSelection } from "../shared/model-selection.ts";

export interface PendingModelBot {
  modelSelection: ModelSelection;
  pendingModelSelection?: ModelSelection;
  busy?: boolean;
}

/** Bot fields a model pick writes: busy holds it, idle applies it. */
export function modelPickPatch(
  bot: PendingModelBot,
  selection: ModelSelection,
): Partial<Pick<PendingModelBot, "modelSelection" | "pendingModelSelection">> {
  if (!bot.busy) return { modelSelection: selection, pendingModelSelection: undefined };
  return { pendingModelSelection: sameModelSelection(bot.modelSelection, selection) ? undefined : selection };
}

/** Moves a held pick onto an idle bot; true when it did. */
export function applyPendingModel(bot: PendingModelBot): boolean {
  if (bot.busy || !bot.pendingModelSelection) return false;
  bot.modelSelection = bot.pendingModelSelection;
  delete bot.pendingModelSelection;
  return true;
}
