// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";

const { api, dispatch } = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api,
  useStore: () => ({ state: {}, dispatch }),
}));

import { PluginsPanel } from "./PluginsPanel";

it("keeps account confirmation in Korean and owns focus above the Connected Apps modal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  applyLocale("ko");
  api.mockImplementation(async (path: string) => path.endsWith("/catalog")
    ? { configured: true, mode: "managed", cards: [{ slug: "gmail", label: "Gmail", blurb: "Mail", logo: null, domain: null }] }
    : path.endsWith("/connected")
      ? { authoritative: true, services: { gmail: { connected: true, accounts: [{ id: "ca_work", alias: "work", status: "ACTIVE" }] } } }
      : {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const confirmation = () => document.querySelector('[role="dialog"][aria-describedby]');
  const button = (label: string) => [...confirmation()!.querySelectorAll("button")].find((node) => node.textContent === label)!;
  try {
    await act(async () => root.render(createElement(PluginsPanel)));
    await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
    const disconnect = host.querySelector<HTMLButtonElement>('button[aria-label="Gmail에서 work 연결 해제"]')!;
    disconnect.focus();
    api.mockClear();
    await act(async () => disconnect.click());
    expect(confirmation()?.textContent).toContain("다른 Gmail 계정은 연결된 상태로 유지됩니다.");
    expect(document.activeElement).toBe(button("취소"));
    expect(api).not.toHaveBeenCalled();

    button("연결 해제").focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    button("연결 해제").dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(button("연결 해제"));
    await act(async () => button("연결 해제").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(confirmation()).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(disconnect);
    expect(api).not.toHaveBeenCalled();

    await act(async () => disconnect.click());
    await act(async () => button("취소").click());
    expect(api).not.toHaveBeenCalled();
    await act(async () => disconnect.click());
    await act(async () => button("연결 해제").click());
    expect(api.mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(1);
    expect(api).toHaveBeenCalledWith("/api/connectors/gmail/accounts/ca_work", { method: "DELETE" });
    expect(confirmation()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    applyLocale("en");
    vi.unstubAllGlobals();
  }
});
