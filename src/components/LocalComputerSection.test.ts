// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import { LocalComputerSection } from "./LocalComputerSection";

it.each([
  ["Delete VM", "Delete", ["remove"]],
  ["Delete and Recreate", "Replace", ["remove", "run"]],
] as const)("confirms %s without changing the VM on cancel", async (label, confirmLabel, actions) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  applyLocale("en");
  const status = {
    runtime: "docker", daemonUp: true, image: true, imageMatches: false,
    managed: true, container: "stopped", network: "loopback", security: "hardened",
    persistence: "durable", ready: false, mode: "shared", commands: {},
  };
  const fetch = vi.fn(async (_path: string, _options?: RequestInit) => ({ ok: true, json: async () => status }));
  vi.stubGlobal("fetch", fetch);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const dialog = () => document.querySelector('[role="dialog"]');
  const button = (text: string) => [...dialog()!.querySelectorAll("button")].find((node) => node.textContent === text)!;
  try {
    await act(async () => root.render(createElement(LocalComputerSection)));
    const trigger = [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)!;
    trigger.focus();
    fetch.mockClear();
    await act(async () => trigger.click());
    expect(dialog()?.textContent).toContain("Files and browser sign-ins in its durable workspace will remain.");
    expect(document.activeElement).toBe(button("Cancel"));
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => button("Cancel").click());
    expect(fetch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    await act(async () => button(confirmLabel).click());
    expect(dialog()).toBeNull();
    const posts = fetch.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts.map(([path]) => path)).toEqual(actions.map((action) => `/api/local-computer/${action}`));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
