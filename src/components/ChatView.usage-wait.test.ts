// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { I18nProvider, translate, type LocaleId } from "@/lib/i18n";
import type { UsageWaitView } from "../../server/limit-wait-store";
import { ErrorRow } from "./ChatView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
const resumesAt = Date.parse("2026-10-30T03:40:00Z");
const base: UsageWaitView = { id: "wait", ownerDeviceId: "pc-a", state: "waiting", resumesAt, weekly: false, cancelable: true };

async function mount(locale: LocaleId, view: UsageWaitView) {
  localStorage.setItem("omb-locale", locale);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = async (usageWait: UsageWaitView) => act(async () => root.render(createElement(I18nProvider, null,
    createElement(ErrorRow, { botId: "bot", message: "Provider detail", usageLimit: { resetsAt: null }, usageWait }))));
  await render(view);
  return { host, render, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it.each(["en", "ko"] as const)("renders every usage wait line in %s without duplicate rows", async (locale) => {
  const view = await mount(locale, base);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(resumesAt);
  try {
    expect(view.host.textContent).toContain(translate(locale, "chat.usageWaitAt", { time }));
    expect(view.host.querySelectorAll("button")).toHaveLength(1);
    await view.render({ ...base, resumesAt: null });
    expect(view.host.textContent).toContain(translate(locale, "chat.usageWaitUnknown"));
    expect(view.host.textContent).not.toContain(translate(locale, "chat.usageWaitAt", { time }));
    const weeklyTime = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", weekday: "short" }).format(resumesAt);
    await view.render({ ...base, weekly: true });
    expect(view.host.textContent).toContain(translate(locale, "chat.usageWaitWeekly", { time: weeklyTime }));
    expect(view.host.querySelectorAll("button")).toHaveLength(1);
    await view.render({ ...base, state: "manual" });
    expect(view.host.textContent).toContain(translate(locale, "chat.usageWaitManual"));
    expect(view.host.querySelectorAll("button")).toHaveLength(0);
    expect(view.host.textContent?.match(/Provider detail/g)).toHaveLength(1);
  } finally { await view.close(); }
});

it("Cancel calls the scoped route and a foreign owner's projection stays read-only", async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  const view = await mount("en", base);
  try {
    await act(async () => view.host.querySelector<HTMLButtonElement>("button")!.click());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/bots/bot/usage-wait/wait/cancel", expect.objectContaining({ method: "POST" }));
    await view.render({ ...base, cancelable: false });
    expect(view.host.textContent).toContain("Resumes at");
    expect(view.host.querySelector("button")).toBeNull();
  } finally { await view.close(); }
});
