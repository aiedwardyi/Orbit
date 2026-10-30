import { routineChatOnScreen } from "@/lib/routine-ring";
import { isShownMessage } from "@/lib/shown-message";
import type { AppState, Message } from "./store-types";

type ReadRecord = { threadId?: string; unread?: boolean; readAt?: number };

export function createViewedReplies() {
  const pending = new Map<string, number>();
  return {
    note(state: AppState, threadId: string, message: Message, windowActive: boolean) {
      if (!windowActive || !routineChatOnScreen(state) || message.role !== "bot" || message.kind !== "text" || !isShownMessage(message) || message.at === undefined) return;
      const owner = [...state.bots, ...state.groups].find((record) => record.threadId === threadId);
      if (!owner || owner.id !== state.selectedId) return;
      pending.set(threadId, Math.max(pending.get(threadId) ?? -Infinity, owner.readAt ?? -Infinity, message.at));
    },
    patch(record: ReadRecord, clearUnread: boolean) {
      const readAt = pending.get(record.threadId ?? "");
      const patch: { unread?: false; readAt?: number } = clearUnread ? { unread: false } : {};
      if (readAt !== undefined) {
        if ((record.readAt ?? -Infinity) >= readAt) pending.delete(record.threadId!);
        else patch.readAt = readAt;
      }
      // Keep the boundary until a record frame acknowledges it.
      Object.assign(record, patch);
      return patch.unread === false || patch.readAt !== undefined ? patch : null;
    },
    forget(threadId: string) {
      pending.delete(threadId);
    },
  };
}
