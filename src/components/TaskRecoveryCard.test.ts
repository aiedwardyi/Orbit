import { createElement } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { TaskResumePacket } from "@/state/store";

import { ContextCompactionDivider, TaskRecoveryStrip } from "./TaskRecoveryCard";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "TaskRecoveryCard.tsx"), "utf8");
const chatView = readFileSync(join(here, "ChatView.tsx"), "utf8");
const groupView = readFileSync(join(here, "GroupView.tsx"), "utf8");

const packet: TaskResumePacket = {
  v: 1,
  threadId: "t1",
  botId: "echo",
  goal: "Publish the brief",
  plan: [{ step: "Verify citations", status: "active" }],
  completed: [],
  evidence: [],
  artifacts: [],
  blockers: [],
  nextAction: "Verify the citations against the latest draft and then open a pull request",
  updatedAt: Date.now() - 3 * 60_000,
  updatedBy: "harness",
  flushReason: "crash",
  turnsAtWrite: 2,
};

function renderStrip(overrides: Partial<Parameters<typeof TaskRecoveryStrip>[0]> = {}) {
  applyLocale("en");
  return renderToStaticMarkup(
    createElement(TaskRecoveryStrip, {
      packet,
      turns: 2,
      resuming: false,
      resumeError: null,
      onResume: () => undefined,
      onDismiss: () => undefined,
      ...overrides,
    }),
  );
}

describe("TaskRecoveryStrip", () => {
  it("is a quiet strip: task, saved age, wrapping next action, Resume, dismiss", () => {
    const html = renderStrip();
    expect(html).toContain("Publish the brief");
    expect(html).toContain("saved 3m ago");
    expect(html).toContain("Next:");
    expect(html).toContain("Verify the citations against the latest draft and then open a pull request");
    expect(html).toContain("Resume");
    expect(html).toContain("Dismiss saved task reminder");
    expect(html).not.toContain("size-8");
    expect(html).not.toContain("border-accent/25");
    expect(html).not.toContain("shadow-sm");
    expect(html).not.toContain("backdrop-blur");
    expect(html).toContain("border-hairline");
  });

  it("does not truncate next-action while the goal gets two lines", () => {
    const html = renderStrip();
    expect(html).not.toContain("line-clamp-2");
    expect(html).not.toMatch(/truncate[^"]*next|next[^"]*truncate/i);
    expect(html).toMatch(/whitespace-normal|break-words/);
    expect(source).not.toMatch(/line-clamp-2/);
    expect(source).not.toMatch(/truncate text-\[12\.5px\] text-ink/);
  });

  it("shows Resuming immediately while the request is pending and keeps failure beside the action", () => {
    expect(renderStrip({ resuming: true })).toContain("Resuming");
    expect(renderStrip({ resuming: true })).not.toMatch(/>Resume</);
    const failed = renderStrip({ resumeError: "this task has no interrupted work to continue" });
    expect(failed).toContain("this task has no interrupted work to continue");
    expect(failed).toContain("text-danger");
    expect(failed).toContain("Resume");
  });

  it("keeps Resume and dismiss after a stop flush", () => {
    const html = renderStrip({ packet: { ...packet, flushReason: "stop" } });
    expect(html).toContain("Task paused");
    expect(html).toContain("Resume");
    expect(html).toContain("Dismiss saved task reminder");
    expect(source).toMatch(/isTaskRecoveryVisible\(packet, (?:busy \?\? )?bot\.busy\)/);
  });

  it("stays click-to-resume and lives in the composer column", () => {
    const resetEffect = source.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[bot\.id, packet\?\.threadId\]\)/)?.[0] ?? "";
    expect(resetEffect).toContain("setResuming(false)");
    expect(resetEffect).not.toContain("resumeTask");
    expect(source).toContain('type: "resumeTask"');
    expect(source).toContain("onSettled");
    expect(chatView).toContain("<TaskRecoveryCard");
    expect(chatView).toContain("CHAT_COLUMN_CLASS");
    expect(chatView.indexOf("<TaskRecoveryCard")).toBeGreaterThan(chatView.indexOf("composerDockRef"));
    expect(groupView).toContain("<TaskRecoveryCard");
    expect(groupView).toContain("CHAT_COLUMN_CLASS");
    expect(groupView.indexOf("<TaskRecoveryCard")).toBeGreaterThan(groupView.indexOf("composerDockRef"));
    expect(groupView).toContain("recoveryPacket?.botId");
  });

  it("resets pending and error chrome when the bot or task changes", () => {
    expect(chatView).toContain("key={`${bot.id}:${activeTask?.threadId ?? bot.threadId}`}");
    expect(source).toMatch(/bot\.id.*packet\?\.threadId|packet\?\.threadId.*bot\.id/);
  });
});

describe("ContextCompactionDivider", () => {
  it("makes the existing disclosure obvious without changing summary payload", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(
      createElement(ContextCompactionDivider, {
        message: {
          id: "c1",
          role: "bot",
          kind: "compaction",
          at: 1,
          compaction: {
            v: 1,
            summary: "Kept the signing plan and the last test failure.",
            coveredThroughId: "m10",
            firstKeptId: "m11",
            contextWindow: 200_000,
            estimatedTokensBefore: 180_000,
            sourceMessageCount: 40,
          },
        },
      }),
    );
    expect(html).toContain("Earlier messages summarized");
    expect(html).toContain("Full chat kept");
    expect(html).toContain("<details");
    expect(html).toContain("Kept the signing plan and the last test failure.");
    expect(html).toContain("<svg");
    expect(source).toContain("group-open:rotate");
    expect(source).not.toContain("Older context was summarized");
  });
});
