import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import type { Bot, Message } from "@/state/store";
import { BotListItem } from "./SidebarConversations";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => store }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

afterEach(() => { applyLocale("en"); });

it.each(["en", "ko"] as const)("yields the model line to workers and restores it in %s", async (locale) => {
  applyLocale(locale);
  const launch: Message = { id: "launch", at: 1, role: "bot", kind: "launch", text: "Launched ALPHA | Muse 1.3 | high\nSession: aaaaaaaa-1" };
  const bot = { id: "ada", name: "Ada", threadId: "thread", messages: [launch], modelSelection: { instanceId: "muse", model: "muse-spark-1.3" } } as Bot;
  store.state = { bots: [bot], instances: [{ instanceId: "muse", driverKind: "museAgent", models: { options: [{ id: "muse-spark-1.3", label: "Muse 1.3" }] } }], config: {}, terminalAttention: {}, terminalPanes: { ada: ["ALPHA | Muse 1.3 | high"] }, routineRuns: [], activeView: "chat", selectedId: "ada" };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = async () => { await act(async () => root.render(createElement(BotListItem, { bot, density: "comfortable", onMenu: () => {} }))); };
  try {
    await render();
    expect(host.querySelector("[data-sidebar-worker-status]")?.textContent).toBe(locale === "en" ? "1 worker working" : "작업자 1개 작업 중");
    expect(host.querySelector("[data-sidebar-model-row]")).toBeNull();
    expect(host.querySelector("[data-sidebar-worker-panes]")).toBeNull();
    expect(host.textContent).not.toContain(">_");
    bot.messages = [...bot.messages, { id: "done", at: 2, role: "bot", kind: "note", text: "[pane aaaaaaaa] [ALPHA | Muse 1.3 | high] from Ada (ada): DONE ALPHA branch=x sha=y dirty=no" }];
    await render();
    expect(host.querySelector("[data-sidebar-worker-status]")).toBeNull();
    expect(host.querySelector("[data-sidebar-model-label]")?.textContent).toContain("Muse 1.3");
    store.state.terminalPanes = {};
    await render();
    expect(host.querySelector("[data-sidebar-model-label]")?.textContent).toContain("Muse 1.3");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
