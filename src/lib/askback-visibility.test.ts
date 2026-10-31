import { describe, expect, it } from "vitest";

import { searchHaystack } from "../../server/message-db.ts";
import { commLabel } from "@/components/PeerMessage";
import { conversationPreview } from "./conversation-preview";
import { messageVisible } from "./chat-transcript";
import { t } from "./i18n";
import type { Message } from "@/state/store";

const today: Message = {
  id: "reply", at: 1, role: "bot", kind: "activity",
  text: "@Sender, which branch should I check?",
  tool: { name: "Reply from @Helper" },
  comm: { groupId: "pair", withBotId: "helper", withName: "Helper", withColor: "purple", peer: "reply" },
};
const waking = { ...today, origin: "local-device", comm: { ...today.comm!, wake: true as const } };

describe("ask-back activity visibility", () => {
  it.each([false, true])("preserves the reply label, sidebar preview and search text (tools: %s)", (showToolCalls) => {
    const bot = (message: Message) => ({ messages: [message], activeLeafId: message.id });
    expect(commLabel(waking, t)).toBe(commLabel(today, t));
    expect(commLabel(waking, t)).toBe("Reply from @Helper");
    expect(conversationPreview(bot(waking), t, showToolCalls)).toBe(conversationPreview(bot(today), t, showToolCalls));
    expect(conversationPreview(bot(waking), t, showToolCalls)).toBe("Reply from @Helper");
    expect(searchHaystack(waking, showToolCalls)).toBe(searchHaystack(today, showToolCalls));
    expect(messageVisible(waking, { transcript: [waking], showToolCalls })).toBe(true);
    expect(waking.text).toBe(today.text);
  });
});
