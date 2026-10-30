import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import { workerRuns } from "@/lib/worker-runs";
import type { Bot, Message } from "@/state/store";
import { BotListItem } from "./SidebarConversations";
import { WorkerChip } from "./WorkerRows";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => store }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

afterEach(() => { applyLocale("en"); });

it.each(["en", "ko"] as const)("counts two working and one waiting, then hides the header and restores the list model when all finish in %s", async (locale) => {
  applyLocale(locale);
  const workers = [["ALPHA", "aaaaaaaa-1"], ["BETA", "bbbbbbbb-1"], ["GUIDE", "cccccccc-1"]] as const;
  const launches: Message[] = workers.map(([nick, session], index) => ({ id: `launch-${nick}`, at: index + 1, role: "bot", kind: "launch", text: `Launched ${nick} | Muse 1.3 | high\nSession: ${session}` }));
  const waiting: Message = { id: "waiting", at: 4, role: "bot", kind: "note", text: "[pane cccccccc] [GUIDE | Muse 1.3 | high] from Ada (ada): BLOCKED GUIDE branch=x sha=y dirty=no" };
  const bot = { id: "ada", name: "Ada", threadId: "thread", messages: [...launches, waiting], modelSelection: { instanceId: "muse", model: "muse-spark-1.3" } } as Bot;
  const livePanes = new Set(workers.map(([, session]) => session));
  store.state = { bots: [bot], instances: [{ instanceId: "muse", driverKind: "museAgent", models: { options: [{ id: "muse-spark-1.3", label: "Muse 1.3" }] } }], config: {}, terminalAttention: {}, terminalPanes: { ada: workers.map(([nick]) => `${nick} | Muse 1.3 | high`) }, routineRuns: [], activeView: "chat", selectedId: "ada" };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = async () => { await act(async () => root.render(createElement("div", null,
    createElement(WorkerChip, { name: bot.name, runs: workerRuns(bot.messages).map((run) => ({ run, state: run.state })), livePanes }),
    createElement(BotListItem, { bot, density: "comfortable", onMenu: () => {} }),
  ))); };
  try {
    await render();
    expect(host.querySelector("[data-worker-status]")?.textContent).toBe(locale === "en" ? "3 workers" : "작업자 3개");
    expect(host.querySelector("[data-sidebar-worker-status]")?.textContent).toBe(locale === "en" ? "3 workers" : "작업자 3개");
    expect(host.querySelector("[data-sidebar-model-row]")).toBeNull();
    expect(host.querySelector("[data-sidebar-worker-panes]")).toBeNull();
    expect(host.textContent).not.toContain(">_");
    bot.messages = [...bot.messages, ...workers.map(([nick, session], index): Message => ({ id: `done-${nick}`, at: index + 5, role: "bot", kind: "note", text: `[pane ${session.slice(0, 8)}] [${nick} | Muse 1.3 | high] from Ada (ada): DONE ${nick} branch=x sha=y dirty=no` }))];
    await render();
    expect(host.querySelector("[data-worker-status]")).toBeNull();
    expect(host.querySelector("[data-sidebar-worker-status]")).toBeNull();
    expect(host.querySelector("[data-sidebar-model-label]")?.textContent).toContain("Muse 1.3");
    store.state.terminalPanes = {};
    await render();
    expect(host.querySelector("[data-sidebar-model-label]")?.textContent).toContain("Muse 1.3");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
