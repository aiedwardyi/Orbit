import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { conversationPreview, roomConversationPreview, transcriptIdleAfterOnboarding } from "./conversation-preview";
import { t, translate, type Translate } from "@/lib/i18n";
import { initialState, previewMessages, reducer, visibleMessages, type Bot, type Group, type Message, type OptionCardData } from "@/state/store";

const quizCard = {
  title: "What do you mostly want help with?",
  subtitle: "Pick whatever's closest; we can always expand from there.",
  options: ["Work & projects", "Writing & research", "Life admin", "A bit of everything"],
};

const quiz: Message = {
  id: "q",
  role: "bot",
  kind: "options",
  card: quizCard,
  at: 2,
};

const bot = (messages: Message[], extra: Partial<Bot> = {}): Pick<Bot, "activity" | "busy" | "messages" | "activeLeafId"> => ({
  messages,
  activeLeafId: messages.at(-1)?.id ?? null,
  ...extra,
});

describe("conversationPreview after first-turn ignore", () => {
  it("shows the open first-turn quiz title", () => {
    expect(conversationPreview(bot([quiz]))).toBe("What do you mostly want help with?");
  });

  it("follows the UI language for the open quiz and still detects it once answered or ignored", () => {
    const ko: Translate = (key, vars) => translate("ko", key, vars);
    expect(conversationPreview(bot([quiz]), ko)).toBe("주로 어떤 일에 도움이 필요하세요?");
    const answered: Message = { ...quiz, card: { ...quizCard, answered: "업무와 프로젝트", dismissed: true } };
    expect(conversationPreview(bot([answered]), ko)).toBe("업무와 프로젝트");
    expect(transcriptIdleAfterOnboarding([answered])).toBe(false);
    expect(transcriptIdleAfterOnboarding([{ ...quiz, card: { ...quizCard, dismissed: true } }])).toBe(true);
  });

  it("does not keep the unanswered question after the quiz is ignored", () => {
    const dismissed: Message = { ...quiz, card: { ...quizCard, dismissed: true } };
    expect(conversationPreview(bot([dismissed]))).toBe("");
    expect(transcriptIdleAfterOnboarding([dismissed])).toBe(true);
  });

  it("walks back to the previous line when the ignored quiz is the tail", () => {
    const greeting: Message = { id: "g", role: "bot", kind: "text", text: "Hey — I'm Nova.", at: 1 };
    const dismissed: Message = { ...quiz, parentId: "g", card: { ...quizCard, dismissed: true } };
    expect(conversationPreview(bot([greeting, dismissed]))).toBe("Hey — I'm Nova.");
  });

  it("still previews a live approval after ignore is not involved", () => {
    const ask: Message = {
      id: "ask",
      role: "bot",
      kind: "options",
      at: 3,
      card: {
        title: "Approval needed",
        subtitle: "rm",
        options: ["Allow", "Deny"],
        requestId: "r1",
        tool: "Bash",
      },
    };
    expect(conversationPreview(bot([ask]))).toBe("Approval needed");
  });

  const decided = (behavior: "allow" | "deny", card: Partial<OptionCardData> = {}): Bot => {
    const prompt: Message = { id: "u", role: "user", kind: "text", text: "clean the build", at: 1 };
    const ask: Message = {
      id: "ask",
      role: "bot",
      kind: "options",
      at: 2,
      parentId: "u",
      card: { title: "Approval needed", subtitle: "rm -rf ./build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash", ...card },
    };
    const asking = { id: "b1", threadId: "t1", name: "B", messages: [prompt, ask], activeLeafId: "ask", busy: false };
    // SAFETY: answerCard and messagePatched read only id, threadId, messages and activeLeafId.
    let state = { ...initialState, bots: [asking as Bot] };
    state = reducer(state, { type: "answerCard", botId: "b1", messageId: "ask", answer: behavior === "allow" ? "Allow" : "Deny" });
    // server/index.ts request.resolved: answered = behavior, dismissed only for a non-user source
    state = reducer(state, {
      type: "messagePatched",
      threadId: "t1",
      message: { ...ask, card: { ...ask.card!, answered: behavior, dismissed: false } },
    });
    return state.bots[0]!;
  };
  const ko: Translate = (key, vars) => translate("ko", key, vars);

  it("previews Denied once the approval is denied", () => {
    const denied = decided("deny");
    expect(denied.busy).toBe(false);
    expect(conversationPreview(denied)).toBe("Denied");
    expect(conversationPreview(denied, ko)).toBe("거부됨");
  });

  it("previews Allowed once the approval is allowed and nothing follows", () => {
    const allowed = decided("allow");
    expect(allowed.busy).toBe(false);
    expect(conversationPreview(allowed)).toBe("Allowed");
    expect(conversationPreview(allowed, ko)).toBe("허용됨");
  });

  it("previews the routine outcome the chat records", () => {
    const routineRequest = {
      version: 1 as const,
      requestId: "r1",
      botId: "b1",
      threadId: "t1",
      createdAt: 1,
      operation: { action: "delete" as const, routineId: "routine-1", expectedUpdatedAt: 1 },
    };
    expect(conversationPreview(decided("allow", { tool: "manage_routine", routineRequest }))).toBe("Routine deleted");
    expect(conversationPreview(decided("deny", { tool: "manage_routine", routineRequest }))).toBe("Cancelled");
  });

  it("keeps waiting-on-you above any leftover quiz text", () => {
    expect(conversationPreview(bot([quiz], { activity: "waiting-on-you" }))).toBe("Waiting for you…");
  });

  it("does not treat a chosen option as an ignored leftover", () => {
    const answered: Message = { ...quiz, card: { ...quizCard, answered: "Work & projects", dismissed: true } };
    expect(transcriptIdleAfterOnboarding([answered])).toBe(false);
    expect(conversationPreview(bot([answered]))).toBe("Work & projects");
  });

  it("previews a chosen option even when dismissed is unset", () => {
    const answered: Message = { ...quiz, card: { ...quizCard, answered: "Work & projects" } };
    expect(transcriptIdleAfterOnboarding([answered])).toBe(false);
    expect(conversationPreview(bot([answered]))).toBe("Work & projects");
  });

  it("shows the chosen answer once they pick an option", () => {
    const answered: Message = { ...quiz, card: { ...quizCard, answered: "Work & projects", dismissed: true } };
    const choice: Message = { id: "u", role: "user", kind: "text", text: "Work & projects", at: 3, parentId: "q" };
    expect(conversationPreview(bot([answered, choice]))).toBe("Work & projects");
  });
});

describe("sidebar preview hides tool names when Show tool calls is off", () => {
  const greeting: Message = { id: "g", role: "bot", kind: "text", text: "Hey — I'm Nova.", at: 1 };
  const useTool: Message = {
    id: "t",
    role: "bot",
    kind: "activity",
    tool: { name: "use_tool", ok: true },
    at: 2,
    parentId: "g",
    from: { botId: "skye", name: "Skye", color: "blue" },
  };

  it("walks back to the last spoken line on a 1:1 row (default off)", () => {
    expect(conversationPreview(bot([greeting, useTool]))).toBe("Hey — I'm Nova.");
    expect(conversationPreview(bot([useTool]))).toBe("");
    expect(conversationPreview(bot([greeting, useTool]))).not.toContain("use_tool");
  });

  it("still names the tool on a 1:1 row when Show tool calls is on", () => {
    expect(conversationPreview(bot([greeting, useTool]), t, true)).toBe("use_tool");
  });

  it("does not render Skye: use_tool on a room row (default off)", () => {
    const room = {
      messages: [greeting, useTool],
    } as Pick<Group, "busyBotId" | "messages">;
    expect(roomConversationPreview(room)).toBe("Hey — I'm Nova.");
    expect(roomConversationPreview({ messages: [useTool] })).toBe("No messages yet");
    expect(roomConversationPreview(room)).not.toMatch(/Skye:\s*use_tool/);
  });

  it("keeps Skye: use_tool on a room row when Show tool calls is on", () => {
    const room = { messages: [useTool] } as Pick<Group, "busyBotId" | "messages">;
    expect(roomConversationPreview(room, [], true)).toBe("Skye: use_tool");
  });

  it("shows a working room while its next member is queued", () => {
    expect(roomConversationPreview({ working: true, messages: [] })).toBe("A bot is working…");
  });

  it("passes Show tool calls into Sidebar 1:1 and room preview chrome", () => {
    const sidebar = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../components/Sidebar.tsx"),
      "utf8",
    );
    expect(sidebar).toMatch(/conversationPreview\([^)]*showToolCalls/);
    expect(sidebar).toMatch(/roomConversationPreview\([^)]*showToolCalls/);
    expect(sidebar).not.toMatch(/last\.kind === "activity" && last\.tool \? last\.tool\.name/);
  });
});

describe("sidebar preview skips summarized notes", () => {
  const from = { botId: "wink", name: "Wink", color: "blue" } as const;
  const reply: Message = { id: "r", role: "bot", kind: "text", text: "Report is ready.", at: 1, from };
  const note: Message = { id: "s", role: "bot", kind: "text", text: "Reformatting the table.", at: 2, parentId: "r", summarized: true, from };

  it("previews the last real line on a 1:1 row", () => {
    expect(conversationPreview(bot([reply, note]))).toBe("Report is ready.");
  });

  it("previews the last real line on a room row", () => {
    expect(roomConversationPreview({ messages: [reply, note] })).toBe("Wink: Report is ready.");
    expect(roomConversationPreview({ messages: [note] })).toBe("No messages yet");
  });
});

describe("paged preview", () => {
  it("falls back to the newest loaded row while the selected leaf is on an older page", () => {
    const newest: Message = { id: "m9", role: "bot", kind: "text", text: "newest loaded", at: 9 };
    const paged = { ...bot([newest]), activeLeafId: "m1", hasMore: true };
    expect(conversationPreview(paged)).toBe("newest loaded");
    expect(previewMessages(paged)).toEqual([newest]);
    expect(visibleMessages(paged)).toEqual([]);
  });
});

describe("sidebar preview strips pasted-text wrapper", () => {
  it("strips pasted-text wrapper in 1:1 bot conversation preview", () => {
    const raw = '<pasted-text index="1">\nhello world from paste\n</pasted-text>';
    const message: Message = { id: "m1", role: "user", kind: "text", text: raw, at: 1 };
    expect(conversationPreview(bot([message]))).toBe("hello world from paste");
  });

  it("strips pasted-text wrapper in room conversation preview", () => {
    const raw = '<pasted-text index="1">\nroom paste preview\n</pasted-text>';
    const message: Message = { id: "m1", role: "user", kind: "text", text: raw, at: 1 };
    const room = { messages: [message] };
    expect(roomConversationPreview(room)).toBe("You: room paste preview");
  });
});

describe("sidebar preview of worker rows", () => {
  it("previews a note in plain words, never the mailbox header", () => {
    const note: Message = { id: "n1", role: "bot", kind: "note", at: 1, text: "[pane bc9c674b] [QCARD-FIX | Opus 5.5 | high] from Wink (61902933-1c2d-4e5f-8a9b-0c1d2e3f4a5b): FAIL QCARD-FIX branch=fix/q sha=3623665c dirty=no\nThe build broke." };
    expect(conversationPreview(bot([note]))).toBe("Failed: The build broke.");
    expect(conversationPreview(bot([note]), (key, vars) => translate("ko", key, vars))).toBe("실패: The build broke.");
  });

  it("previews a launch by its header line only", () => {
    const launch: Message = { id: "l1", role: "bot", kind: "launch", at: 1, text: "Launched QCARD-FIX | Opus 5.5 | high\nLabel: QCARD-FIX | Opus 5.5 | high\nWorking folder: C:/repo\nSession: bc9c674b-2844-43b0-982e-88305df70570" };
    expect(conversationPreview(bot([launch]))).toBe("Launched QCARD-FIX | Opus 5.5 | high");
  });
});
