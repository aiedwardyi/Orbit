import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { conversationPreview, roomConversationPreview, showComposerPermissionChip, transcriptIdleAfterOnboarding } from "./conversation-preview";
import { t, translate, type Translate } from "@/lib/i18n";
import { initialState, reducer, type Bot, type Group, type Message, type OptionCardData } from "@/state/store";

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

  it("hides the Ask-for-approval chip after the first-turn quiz is ignored", () => {
    expect(showComposerPermissionChip([])).toBe(true);
    expect(showComposerPermissionChip([quiz])).toBe(true);
    expect(showComposerPermissionChip([{ ...quiz, card: { ...quizCard, dismissed: true } }])).toBe(false);
  });

  it("hides the Ask-for-approval chip on an engine that can never ask", () => {
    const chat: Message = { id: "u", role: "user", kind: "text", text: "hi", at: 1 };
    expect(showComposerPermissionChip([], false)).toBe(false);
    expect(showComposerPermissionChip([chat], false)).toBe(false);
    expect(showComposerPermissionChip([chat], true)).toBe(true);
  });

  it("does not treat a chosen option as an ignored leftover", () => {
    const answered: Message = { ...quiz, card: { ...quizCard, answered: "Work & projects", dismissed: true } };
    expect(transcriptIdleAfterOnboarding([answered])).toBe(false);
    expect(showComposerPermissionChip([answered])).toBe(true);
    expect(conversationPreview(bot([answered]))).toBe("Work & projects");
  });

  it("previews a chosen option even when dismissed is unset", () => {
    const answered: Message = { ...quiz, card: { ...quizCard, answered: "Work & projects" } };
    expect(transcriptIdleAfterOnboarding([answered])).toBe(false);
    expect(showComposerPermissionChip([answered])).toBe(true);
    expect(conversationPreview(bot([answered]))).toBe("Work & projects");
  });

  it("shows the chosen answer once they pick an option", () => {
    const answered: Message = { ...quiz, card: { ...quizCard, answered: "Work & projects", dismissed: true } };
    const choice: Message = { id: "u", role: "user", kind: "text", text: "Work & projects", at: 3, parentId: "q" };
    expect(conversationPreview(bot([answered, choice]))).toBe("Work & projects");
    expect(showComposerPermissionChip([answered, choice])).toBe(true);
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
