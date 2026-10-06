import "./ProfileFields.test-dom.ts";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Action } from "@/state/store";

const dispatched: Action[] = [];
const apiCalls: string[] = [];
let bots: Array<{ id: string; hidden: boolean }> = [];

const entry = {
  slug: "alpha",
  name: "Alpha",
  summary: "A team",
  category: "work",
  manifest: "alpha.md",
  readme: "README.md",
  members: 1,
  skills: [],
  requires: { apps: [] },
};

const manifest = {
  format: "openmaus.team",
  version: 2,
  team: { name: "Alpha", members: [{ name: "Ada", title: "Lead" }] },
};

type CatalogBody = { repositoryUrl: string; teams: Array<typeof entry> };
type TeamBody = typeof manifest;
type ImportBody = { bots: Array<{ id: string }>; groups: Array<{ id: string; messages: [] }> };

async function apiImpl(path: string): Promise<CatalogBody | TeamBody | ImportBody> {
  apiCalls.push(path);
  if (path === "/api/team-library/catalog") return { repositoryUrl: "", teams: [entry] };
  if (path === "/api/team-library/teams/alpha") return manifest;
  if (path.startsWith("/api/teams/import")) {
    return { bots: [{ id: "new-bot" }], groups: [{ id: "room-1", messages: [] }] };
  }
  throw new Error(path);
}

// oxlint-disable-next-line anti-slop/no-module-mocking -- The panel talks to the app API; this harness records the import mode and selection.
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: (path: string) => apiImpl(path),
    useStore: () => ({
      state: { bots },
      dispatch: (action: Action) => {
        dispatched.push(action);
      },
    }),
  };
});

import { TeamLibraryPanel } from "./TeamLibraryPanel";

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button "${text}" missing`);
  return found;
}

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

afterEach(() => {
  document.body.replaceChildren();
  dispatched.length = 0;
  apiCalls.length = 0;
  bots = [];
});

describe("team import with bots already on the team", () => {
  it("makes Add the primary button, keeps Replace secondary, and selects the new group", async () => {
    bots = [
      { id: "visible", hidden: false },
      { id: "archived", hidden: true },
    ];
    const { root } = await renderPanel();
    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Alpha");
      });
      await act(async () => {
        button("Load").click();
      });
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Add team");
      });

      expect(document.body.textContent).toContain("Add team keeps your current bots.");
      expect(document.body.textContent).toContain("Replace team moves your 1 current bot to Archived bots.");
      expect(button("Add team").className).toContain("bg-accent");
      expect(button("Replace team").className).not.toContain("bg-accent");
      expect(document.body.textContent).not.toContain("Add alongside instead");

      await act(async () => {
        button("Add team").click();
      });
      await vi.waitFor(() => {
        expect(apiCalls.some((path) => path.includes("mode=add"))).toBe(true);
      });
      const selected = dispatched.find((action) => action.type === "select");
      expect(selected).toEqual({ type: "select", id: "room-1" });
      const groupAt = dispatched.findIndex((action) => action.type === "groupPatched");
      const selectAt = dispatched.findIndex((action) => action.type === "select");
      expect(groupAt).toBeGreaterThan(-1);
      expect(selectAt).toBeGreaterThan(groupAt);

      await act(async () => {
        button("Replace team").click();
      });
      await vi.waitFor(() => {
        expect(apiCalls.some((path) => path.includes("mode=replace"))).toBe(true);
      });
    } finally {
      await act(async () => root.unmount());
    }
  });
});
