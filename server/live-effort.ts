// An effort pick on a busy bot is held as before, then moved into the running
// turn when its engine can take it there.
import type { ModelSelection } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import { sameModelSelection } from "../shared/model-selection.ts";
import type { Store } from "./store.ts";

/** Commits a busy bot's effort-only pick once its running turn carries it; false leaves it held. */
export async function applyEffortPick(store: Store, registry: ProviderRegistry, botId: string, selection: ModelSelection): Promise<boolean> {
  const bot = store.bot(botId);
  if (!bot?.busy || !selection.effort) return false;
  const running = bot.modelSelection;
  // a pick back to the running effort goes too: a switch still in flight may have moved the turn
  if (
    selection.instanceId !== running.instanceId ||
    selection.model !== running.model ||
    (selection.mode ?? "pinned") !== (running.mode ?? "pinned")
  ) return false;
  const adapter = registry.get(running.instanceId)?.adapter;
  if (!adapter?.applyEffort) return false;
  let applied = false;
  try {
    applied = await adapter.applyEffort(bot.activeThreadId ?? bot.threadId, selection.effort);
  } catch {}
  const now = store.bot(botId);
  if (!applied || !now || !sameModelSelection(now.pendingModelSelection ?? now.modelSelection, selection)) return false;
  store.patchBot(botId, { modelSelection: selection, pendingModelSelection: undefined });
  return true;
}
