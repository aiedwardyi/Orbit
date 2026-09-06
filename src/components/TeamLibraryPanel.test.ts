import "./ProfileFields.test-dom.ts";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics", () => ({
  track: () => undefined,
}));

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: async () => ({ repositoryUrl: "", teams: [] }),
    useStore: () => ({
      state: { bots: [] },
      dispatch: () => undefined,
    }),
  };
});

import { TeamLibraryPanel } from "./TeamLibraryPanel";

async function renderPanel() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(TeamLibraryPanel, {
        onClose: () => undefined,
        onImported: () => undefined,
        returnFocusRef: createRef<HTMLButtonElement>(),
      }),
    );
  });
  return { host, root };
}

describe("team library import copy", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps drop-zone text free of BotMRR and .mausteam.json", async () => {
    await renderPanel();
    const importTab = [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "Import");
    expect(importTab).toBeTruthy();
    await act(async () => {
      (importTab as HTMLButtonElement).click();
    });

    const visible = document.body.textContent ?? "";
    expect(visible).toContain("or drop a playbook .md / legacy team JSON here");
    expect(visible).not.toContain("BotMRR");
    expect(visible).not.toContain(".mausteam.json");
    expect(document.querySelector('input[type="file"]')?.getAttribute("accept")).toContain(".mausteam.json");
  });
});
