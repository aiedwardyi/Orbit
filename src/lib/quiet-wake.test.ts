import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { autoSpeaks } from "@/state/store-transforms";
import { messageVisible } from "./chat-transcript";
import { messageVisible as roomMessageVisible } from "./room-transcript";
import { unreadReplyCount } from "./unread";

const quiet: Message = { id: "quiet", at: 3, role: "bot", kind: "text", text: "·", hidden: true };

describe("quiet wake clients", () => {
  it("hides the reply in chat and rooms with tool calls on or off", () => {
    for (const showToolCalls of [false, true]) {
      expect(messageVisible(quiet, { showToolCalls, transcript: [quiet] })).toBe(false);
      expect(roomMessageVisible(quiet, showToolCalls)).toBe(false);
    }
  });

  it("does not speak the reply or add it to an existing unread count", () => {
    expect(autoSpeaks({ message: quiet })).toBe(false);
    const visible: Message = { ...quiet, id: "visible", at: 2, text: "The checks passed.", hidden: undefined };
    expect(unreadReplyCount(true, 1, [visible, quiet, { ...quiet, id: "quiet2", at: 4 }])).toBe(1);
  });
});
