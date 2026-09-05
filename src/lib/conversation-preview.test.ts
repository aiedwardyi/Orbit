import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { conversationPreview, roomConversationPreview, showComposerPermissionChip, transcriptIdleAfterOnboarding } from "./conversation-preview";
import { t } from "@/lib/i18n";
import type { Bot, Group, Message } from "@/state/store";

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

  it("keeps waiting-on-you above any leftover quiz text", () => {
    expect(conversationPreview(bot([quiz], { activity: "waiting-on-you" }))).toBe("Waiting for you…");
  });

  it("hides the Ask-for-approval chip after the first-turn quiz is ignored", () => {
    expect(showComposerPermissionChip([])).toBe(true);
    expect(showComposerPermissionChip([quiz])).toBe(true);
    expect(showComposerPermissionChip([{ ...quiz, card: { ...quizCard, dismissed: true } }])).toBe(false);
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
