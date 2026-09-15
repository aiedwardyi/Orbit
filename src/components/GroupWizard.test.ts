// GroupWizard merged members screen: checkbox picks, inline + rows with
// engine-default models, live-count create, draft retention on failure.
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
const defaultBots = [
  { id: "b1", name: "Ada", hidden: false, modelSelection: { instanceId: "codex-1", model: "m" } },
  { id: "b2", name: "Bo", hidden: false, modelSelection: { instanceId: "muse-1", model: "c" } },
] as Bot[];
let bots: Bot[] = [...defaultBots];

const engine = (instanceId: string, driverKind: string, displayName: string): InstanceInfo => ({
  instanceId,
  driverKind,
  displayName,
  snapshot: { state: "available", authenticated: true },
  models: { default: `${instanceId}-model`, options: [{ id: `${instanceId}-model`, label: `${displayName} Model` }] },
});

/** Antigravity fixture with a catalog-shaped option list, including tiers the
 * wizard must not offer (3.1-pro, 3.6/3.5, legacy customs). */
const antigravity = (
  instanceId: string,
  displayName: string,
  options: Array<{ id: string; label: string; custom?: boolean }>,
  modelDefault: string,
): InstanceInfo => ({
  instanceId,
  driverKind: "antigravityAgent",
  displayName,
  snapshot: { state: "available", authenticated: true },
  models: { default: modelDefault, options },
});

let instances: InstanceInfo[] = [engine("codex-1", "codex", "Codex"), engine("muse-1", "museAgent", "Meta Muse")];
let botSeq = 0;

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

function jobInputs(host: HTMLElement): HTMLInputElement[] {
  // SAFETY: the selector targets only the wizard job fields rendered above.
  return [...host.querySelectorAll('input[placeholder="For example, research flight options"]')] as HTMLInputElement[];
}

async function toMembers(host: HTMLElement) {
  await act(async () => {
    button(host, "Next").click();
  });
  expect(host.textContent).toContain("Add bots");
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function findCreate(): Extract<Action, { type: "createGroup" }> {
  const create = dispatched.find((a): a is Extract<Action, { type: "createGroup" }> => a.type === "createGroup");
  if (!create) throw new Error("createGroup not dispatched");
  return create;
}

afterEach(() => {
  document.body.replaceChildren();
  dispatched.length = 0;
  apiCalls.length = 0;
  bots = [...defaultBots];
  instances = [engine("codex-1", "codex", "Codex"), engine("muse-1", "museAgent", "Meta Muse")];
  botSeq = 0;
  apiImpl = () => Promise.reject(new Error("unexpected api call"));
});

describe("GroupWizard members", () => {
  it("advances from the prefilled name step to members", async () => {
    const { host, root } = await renderWizard();
    try {
      // SAFETY: the wizard always renders the labelled name input on step 1.
      const name = host.querySelector('input[aria-label="Name your group"]') as HTMLInputElement;
      expect(name.value).toBe("New group");
      await toMembers(host);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("checks existing bots and creates with the setup defaults", async () => {
    const { host, root } = await renderWizard();
    try {
      await toMembers(host);
      await act(async () => {
        pickRow(host, "Ada").click();
      });
      await act(async () => {
        pickRow(host, "Bo").click();
      });
      await act(async () => {
        button(host, "Create group · 2 bots").click();
      });
      const create = findCreate();
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

  it("disables create with no members and allows a single bot", async () => {
    const { host, root } = await renderWizard();
    try {
      await toMembers(host);
      expect(button(host, "Create group · 0 bots").hasAttribute("disabled")).toBe(true);
      await act(async () => {
        pickRow(host, "Ada").click();
      });
      expect(button(host, "Create group · 1 bot").hasAttribute("disabled")).toBe(false);
      await act(async () => {
        button(host, "Create group · 1 bot").click();
      });
      expect(findCreate()).toMatchObject({ memberIds: ["b1"] });
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("adds two inline bots on suggested engines and counts them", async () => {
    apiImpl = () => Promise.resolve({ bot: { id: `nb${++botSeq}`, name: "New bot" } });
    const { host, root } = await renderWizard();
    try {
      await toMembers(host);
      await act(async () => {
        button(host, "+ New bot").click();
      });
      const [job1] = jobInputs(host);
      await act(async () => {
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        native.call(job1, "review my code");
        job1!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        button(host, "Add bot").click();
      });
      await flush();
      expect(JSON.parse(String(apiCalls[0]!.init?.body))).toEqual({
        job: "review my code",
        name: "Review my code",
        modelSelection: { instanceId: "codex-1", model: "codex-1-model" },
      });
      await act(async () => {
        button(host, "Add another").click();
      });
      // SAFETY: the selector targets only the row model dropdowns rendered above.
      const selects = [...host.querySelectorAll('select[aria-label="Change model"]')] as HTMLSelectElement[];
      expect(selects).toHaveLength(1);
      expect(selects[0]!.value).toBe("muse-1-model");
      const [job2] = jobInputs(host);
      await act(async () => {
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        native.call(job2, "plan trips");
        job2!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        button(host, "Add bot").click();
      });
      await flush();
      expect(JSON.parse(String(apiCalls[1]!.init?.body))).toMatchObject({
        modelSelection: { instanceId: "muse-1", model: "muse-1-model" },
      });
      expect(dispatched).toContainEqual(expect.objectContaining({ type: "botAdded" }));
      await act(async () => {
        button(host, "Create group · 2 bots").click();
      });
      expect(findCreate()).toMatchObject({ memberIds: ["nb1", "nb2"] });
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("flags the substitute when the preferred engine is down", async () => {
    instances = [
      { ...engine("codex-1", "codex", "Codex"), snapshot: { state: "available", authenticated: false } },
      engine("muse-1", "museAgent", "Meta Muse"),
    ];
    const { host, root } = await renderWizard();
    try {
      await toMembers(host);
      await act(async () => {
        button(host, "+ New bot").click();
      });
      expect(host.textContent).toContain("Codex isn't connected");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("names Meta Muse in the row-2 substitute notice when muse is down", async () => {
    instances = [
      engine("codex-1", "codex", "Codex"),
      { ...engine("muse-1", "museAgent", "Meta Muse"), snapshot: { state: "available", authenticated: false } },
    ];
    apiImpl = () => Promise.resolve({ bot: { id: `nb${++botSeq}`, name: "New bot" } });
    const { host, root } = await renderWizard();
    try {
      await toMembers(host);
      await act(async () => {
        button(host, "+ New bot").click();
      });
      const [job1] = jobInputs(host);
      await act(async () => {
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        native.call(job1, "review my code");
        job1!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        button(host, "Add bot").click();
      });
      await flush();
      // Second row prefers museAgent (preferIndex 1): muse is down, so the
      // notice must name Meta Muse, never the raw driver kind.
      await act(async () => {
        button(host, "Add another").click();
      });
      expect(host.textContent).toContain("Meta Muse isn't connected");
      expect(host.textContent).not.toContain("museAgent");
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
      await toMembers(host);
      await act(async () => {
        button(host, "+ New bot").click();
      });
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

  it("leads with the create form when no bots exist", async () => {
    bots = [];
    const { host, root } = await renderWizard();
    try {
      await toMembers(host);
      expect(jobInputs(host)).toHaveLength(1);
      expect(host.querySelectorAll('button[role="checkbox"]')).toHaveLength(0);
      expect(host.textContent).not.toContain("+ New bot");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("keeps drafts and shows the error when creation fails", async () => {
    const { host, root } = await renderWizard();
    try {
      await toMembers(host);
      await act(async () => {
        pickRow(host, "Ada").click();
      });
      await act(async () => {
        button(host, "Create group · 1 bot").click();
      });
      const create = findCreate();
      await act(async () => {
        create.onError?.();
      });
      expect(host.querySelector('[role="dialog"]')).not.toBeNull();
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
      expect(host.textContent).toContain("Add bots");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("switches the row engine across every connected engine", async () => {
    apiImpl = () => Promise.resolve({ bot: { id: `nb${++botSeq}`, name: "New bot" } });
    const { host, root } = await renderWizard();
    try {
      await toMembers(host);
      await act(async () => {
        button(host, "+ New bot").click();
      });
      // SAFETY: the engine dropdown is the only select labelled Switch engine.
      const engineSelect = host.querySelector('select[aria-label="Switch engine"]') as HTMLSelectElement;
      expect([...engineSelect.options].map((o) => o.value)).toEqual(["codex-1", "muse-1"]);
      expect(engineSelect.value).toBe("codex-1");
      await act(async () => {
        const native = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
        native.call(engineSelect, "muse-1");
        engineSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      // SAFETY: the selector targets only the row model dropdowns rendered above.
      const modelSelect = host.querySelector('select[aria-label="Change model"]') as HTMLSelectElement;
      expect(modelSelect.value).toBe("muse-1-model");
      const [job] = jobInputs(host);
      await act(async () => {
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        native.call(job, "plan trips");
        job!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        button(host, "Add bot").click();
      });
      await flush();
      expect(JSON.parse(String(apiCalls[0]!.init?.body))).toMatchObject({
        modelSelection: { instanceId: "muse-1", model: "muse-1-model" },
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("offers only 3.8/3.7 tiers for an antigravity row and never blanks the model", async () => {
    apiImpl = () => Promise.resolve({ bot: { id: `nb${++botSeq}`, name: "New bot" } });
    instances = [
      antigravity(
        "ag-1",
        "Antigravity",
        [
          { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash High" },
          { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash Medium" },
          { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash Low" },
          { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
          { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash High" },
          { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
          { id: "legacy-custom", label: "Legacy custom", custom: true },
        ],
        "gemini-3.5-flash",
      ),
    ];
    const { host, root } = await renderWizard();
    try {
      await toMembers(host);
      await act(async () => {
        button(host, "+ New bot").click();
      });
      // SAFETY: the selector targets only the row model dropdowns rendered above.
      const modelSelect = host.querySelector('select[aria-label="Change model"]') as HTMLSelectElement;
      expect([...modelSelect.options].map((o) => o.value)).toEqual([
        "gemini-3.8-flash-high",
        "gemini-3.8-flash-medium",
        "gemini-3.7-flash-low",
      ]);
      // The engine default (3.5) is not offered, so the select resolves to
      // the first offered tier instead of going blank.
      expect(modelSelect.value).toBe("gemini-3.8-flash-high");
      const [job] = jobInputs(host);
      await act(async () => {
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        native.call(job, "summarize docs");
        job!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        button(host, "Add bot").click();
      });
      await flush();
      expect(JSON.parse(String(apiCalls[0]!.init?.body))).toMatchObject({
        modelSelection: { instanceId: "ag-1", model: "gemini-3.8-flash-high" },
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("hides a connected retired engine from the engine dropdown", async () => {
    instances = [
      engine("codex-1", "codex", "Codex"),
      engine("gem-1", "geminiAgent", "Gemini"),
      engine("muse-1", "museAgent", "Meta Muse"),
    ];
    const { host, root } = await renderWizard();
    try {
      await toMembers(host);
      await act(async () => {
        button(host, "+ New bot").click();
      });
      // SAFETY: the engine dropdown is the only select labelled Switch engine.
      const engineSelect = host.querySelector('select[aria-label="Switch engine"]') as HTMLSelectElement;
      expect([...engineSelect.options].map((o) => o.value)).toEqual(["codex-1", "muse-1"]);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
