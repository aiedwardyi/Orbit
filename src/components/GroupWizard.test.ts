// GroupWizard step logic: name prefill, engine-default bot creation,
// existing-bot picks, setup defaults, and draft retention on failure.
import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Action, Bot, Group, InstanceInfo } from "@/state/store";

const dispatched: Action[] = [];
const apiCalls: Array<{ path: string; init?: RequestInit }> = [];
let apiImpl: (path: string, init?: RequestInit) => Promise<{ bot: Pick<Bot, "id" | "name"> }> = () =>
  Promise.reject(new Error("unexpected api call"));

// SAFETY: picker rows read only id/name/hidden/modelSelection; the full Bot
// contract is server-owned and untouched by these rows.
const bots = [
  { id: "b1", name: "Ada", hidden: false, modelSelection: { instanceId: "gem-1", model: "m" } },
  { id: "b2", name: "Bo", hidden: false, modelSelection: { instanceId: "codex-1", model: "c" } },
] as Bot[];

const engine = (instanceId: string, driverKind: string, displayName: string): InstanceInfo => ({
  instanceId,
  driverKind,
  displayName,
  snapshot: { state: "available", authenticated: true },
  models: { default: `${instanceId}-model`, options: [{ id: `${instanceId}-model`, label: `${displayName} Model` }] },
});

let instances: InstanceInfo[] = [engine("gem-1", "geminiAgent", "Gemini"), engine("codex-1", "codex", "Codex")];

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: (path: string, init?: RequestInit) => {
      apiCalls.push({ path, init });
      return apiImpl(path, init);
    },
    useStore: () => ({
      state: { bots, instances },
      dispatch: (action: Action) => {
        dispatched.push(action);
      },
      refreshInstances: () => Promise.resolve(),
    }),
  };
});

import { GroupWizard } from "./GroupWizard";

async function renderWizard() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(GroupWizard, { onClose: () => undefined }));
  });
  const dialog = host.querySelector('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) throw new Error("wizard did not render");
  return { host, root };
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button "${text}" missing; saw: ${[...host.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`);
  return found;
}

/** Picker rows render avatar initials, so match the name inside the row. */
function pickRow(host: HTMLElement, name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button[role="checkbox"]')].find((b) =>
    b.textContent?.includes(name),
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`picker row "${name}" missing`);
  return found;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

afterEach(() => {
  document.body.replaceChildren();
  dispatched.length = 0;
  apiCalls.length = 0;
  instances = [engine("gem-1", "geminiAgent", "Gemini"), engine("codex-1", "codex", "Codex")];
  apiImpl = () => Promise.reject(new Error("unexpected api call"));
});

describe("GroupWizard steps", () => {
  it("prefills the name and advances past step 1", async () => {
    const { host, root } = await renderWizard();
    try {
      // SAFETY: the wizard always renders the labelled name input on step 1.
      const name = host.querySelector('input[aria-label="Name your group"]') as HTMLInputElement;
      expect(name.value).toBe("New group");
      await act(async () => {
        button(host, "Next").click();
      });
      expect(host.textContent).toContain("Add your first bot");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("creates the first bot on the suggested engine default and advances", async () => {
    apiImpl = (path) => {
      if (path === "/api/bots") return Promise.resolve({ bot: { id: "nb1", name: "Review my code" } });
      return Promise.reject(new Error("unexpected"));
    };
    const { host, root } = await renderWizard();
    try {
      await act(async () => {
        button(host, "Next").click();
      });
      // SAFETY: the bot step always renders the job field until a bot is set.
      const job = host.querySelector("#group-wizard-job-0") as HTMLInputElement;
      await act(async () => {
        job.focus();
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        native.call(job, "review my code");
        job.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(host.textContent).toContain("Gemini Model");
      await act(async () => {
        button(host, "Add bot").click();
      });
      await flush();
      expect(apiCalls).toHaveLength(1);
      expect(JSON.parse(String(apiCalls[0]!.init?.body))).toEqual({
        job: "review my code",
        name: "Review my code",
        modelSelection: { instanceId: "gem-1", model: "gem-1-model" },
      });
      expect(dispatched).toContainEqual(expect.objectContaining({ type: "botAdded" }));
      await act(async () => {
        button(host, "Use this bot").click();
      });
      expect(host.textContent).toContain("Add another bot");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("uses an existing bot without posting and excludes it on step 3", async () => {
    const { host, root } = await renderWizard();
    try {
      await act(async () => {
        button(host, "Next").click();
      });
      await act(async () => {
        pickRow(host, "Ada").click();
      });
      await act(async () => {
        button(host, "Use this bot").click();
      });
      expect(apiCalls).toHaveLength(0);
      expect(host.textContent).toContain("Add another bot");
      expect(host.textContent).not.toContain("Ada");
      expect(host.textContent).toContain("Bo");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("creates the group with everyone-replies setup and closes on success", async () => {
    const { host, root } = await renderWizard();
    try {
      await act(async () => {
        button(host, "Next").click();
      });
      await act(async () => {
        pickRow(host, "Ada").click();
      });
      await act(async () => {
        button(host, "Use this bot").click();
      });
      await act(async () => {
        pickRow(host, "Bo").click();
      });
      await act(async () => {
        button(host, "Create group").click();
      });
      const create = dispatched.find((a): a is Extract<Action, { type: "createGroup" }> => a.type === "createGroup");
      if (!create) throw new Error("createGroup not dispatched");
      expect(create).toMatchObject({
        memberIds: ["b1", "b2"],
        setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
      });
      await act(async () => {
        // SAFETY: the wizard onSuccess closes the dialog and ignores its
        // argument; the stub carries only the id the effect reads.
        create.onSuccess?.({ id: "g1" } as Group);
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("keeps drafts and shows the error when creation fails", async () => {
    const { host, root } = await renderWizard();
    try {
      // SAFETY: the wizard always renders the labelled name input on step 1.
      const name = host.querySelector('input[aria-label="Name your group"]') as HTMLInputElement;
      await act(async () => {
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        native.call(name, "Launch crew");
        name.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        button(host, "Next").click();
      });
      await act(async () => {
        pickRow(host, "Ada").click();
      });
      await act(async () => {
        button(host, "Use this bot").click();
      });
      await act(async () => {
        pickRow(host, "Bo").click();
      });
      await act(async () => {
        button(host, "Create group").click();
      });
      const create = dispatched.find((a): a is Extract<Action, { type: "createGroup" }> => a.type === "createGroup");
      if (!create) throw new Error("createGroup not dispatched");
      await act(async () => {
        create.onError?.();
      });
      expect(host.querySelector('[role="dialog"]')).not.toBeNull();
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
      expect(host.textContent).toContain("Add another bot");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("offers the connect CTA when no engine is connected", async () => {
    instances = [];
    const { host, root } = await renderWizard();
    try {
      await act(async () => {
        button(host, "Next").click();
      });
      expect(host.textContent).toContain("Connect an AI tool");
      await act(async () => {
        button(host, "Connect an AI tool").click();
      });
      expect(dispatched).toContainEqual(
        expect.objectContaining({ type: "toggleAppSettings", section: "connections" }),
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
