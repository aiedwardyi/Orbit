import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Action, Bot, Group, InstanceInfo } from "@/state/store";

const { mockState, dispatched } = vi.hoisted(() => ({
  // SAFETY: the test fixture stores only the app's bot and instance collections.
  mockState: { value: { bots: [] as Bot[], instances: [] as InstanceInfo[] } },
  // SAFETY: the mock dispatch receives the app's Action union.
  dispatched: [] as Action[],
}));

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: mockState.value,
      dispatch: (action: Action) => dispatched.push(action),
      refreshInstances: () => Promise.resolve(),
    }),
  };
});

const group: Group = {
  id: "group-1",
  threadId: "thread-1",
  name: "Channel",
  memberIds: [],
  defaultResponder: { kind: "everyone" },
  bulletin: "",
  unread: false,
  createdAt: 0,
  messages: [],
};

describe("ManageMembersPanel Korean title", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "omb-locale" ? "ko" : null),
      setItem: () => {},
      removeItem: () => {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockState.value = { bots: [], instances: [] };
    dispatched.length = 0;
  });

  it("renders the members title in Korean", async () => {
    const { ManageMembersPanel } = await import("./ManageMembersPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(ManageMembersPanel, {
        group,
        onClose: () => undefined,
        triggerRef: { current: null },
      })),
    );
    expect(html).toContain("구성원 관리");
    expect(html).toContain("first-letter:uppercase");
    expect(html).toContain("Channel의 구성원 관리");
    expect(html).toContain("data-manage-create-bot");
    expect(html).toContain("봇 추가 또는 새로 만들기");
    expect(html).not.toContain(">Manage Members<");
    expect(html).not.toContain("Manage members of Channel");
  });

  it("uses the group add flow with an explicit model selection", async () => {
    const existing: Bot = {
      id: "existing",
      threadId: "existing-thread",
      name: "Ada",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex-1", model: "codex-default" },
      messages: [],
    };
    const created: Bot = { ...existing, id: "created", threadId: "created-thread", name: "Review weekly brief" };
    const codex: InstanceInfo = {
      instanceId: "codex-1",
      driverKind: "codex",
      displayName: "Codex",
      snapshot: { state: "available", authenticated: true },
      models: {
        default: "codex-default",
        options: [
          { id: "codex-default", label: "Codex Default" },
          { id: "codex-pro", label: "Codex Pro" },
        ],
      },
    };
    mockState.value = { bots: [existing], instances: [codex] };
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ bot: created }), { status: 201 });
      }),
    );
    const group: Group = {
      id: "group-1",
      threadId: "thread-1",
      name: "Channel",
      memberIds: [existing.id],
      defaultResponder: { kind: "everyone" },
      bulletin: "",
      unread: false,
      createdAt: 0,
      messages: [],
      section: "Work",
    };
    const { ManageMembersPanel } = await import("./ManageMembersPanel");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ManageMembersPanel, {
        group,
        onClose: () => undefined,
        triggerRef: { current: null },
      })));
      await act(async () => host.querySelector<HTMLButtonElement>("[data-manage-create-bot]")!.click());
      const job = host.querySelector<HTMLInputElement>('input[id^="group-wizard-job-"]');
      const selects = [...host.querySelectorAll("select")];
      if (!(job instanceof HTMLInputElement)) throw new Error("group add purpose field did not render");
      expect(selects).toHaveLength(2);
      expect([...selects[1]!.options].map((option) => option.value)).toEqual(["codex-default", "codex-pro"]);

      await act(async () => {
        const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        inputSetter.call(job, "review weekly brief");
        job!.dispatchEvent(new Event("input", { bubbles: true }));
        const selectSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
        selectSetter.call(selects[1], "codex-pro");
        selects[1]!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const add = [...host.querySelectorAll("button")].find(
        (button) =>
          !button.hasAttribute("data-manage-create-bot") &&
          (button.textContent?.includes("Add bot") || button.textContent?.includes("봇 추가")),
      );
      if (!(add instanceof HTMLButtonElement)) throw new Error("group add action did not render");
      await act(async () => add.click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(calls[0]?.body).toEqual({
        job: "review weekly brief",
        name: "Review weekly brief",
        modelSelection: { instanceId: "codex-1", model: "codex-pro" },
        section: "Work",
      });
      expect(dispatched).toContainEqual(expect.objectContaining({ type: "botAdded", bot: created }));
      expect(dispatched).toContainEqual({
        type: "patchGroup",
        groupId: group.id,
        patch: { memberIds: [existing.id, created.id] },
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
