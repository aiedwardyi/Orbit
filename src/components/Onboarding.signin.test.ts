// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { Onboarding } from "./Onboarding";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function renderWith(status: number) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "x" }), { status })));
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => createRoot(host).render(createElement(I18nProvider, null, createElement(Onboarding, { onDone: vi.fn() }))));
  return host;
}

describe("Onboarding engine check", () => {
  it("asks an unpaired phone to sign in instead of blaming the engines", async () => {
    const host = await renderWith(401);
    expect(host.textContent).toContain("Sign in to this PC");
    expect(host.textContent).toContain("Settings → Phone link");
    expect(host.textContent).not.toContain("couldn't check the AI engines");
  });

  it("still reports a real engine check failure", async () => {
    const host = await renderWith(500);
    expect(host.textContent).toContain("Wink couldn't check the AI engines on this computer.");
    expect(host.textContent).not.toContain("Sign in to this PC");
  });
});
