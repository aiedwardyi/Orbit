import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Group } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: { bots: [] },
      dispatch: () => undefined,
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
    expect(html).not.toContain(">Manage Members<");
  });
});
