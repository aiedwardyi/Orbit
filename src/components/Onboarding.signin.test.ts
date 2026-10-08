// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { Onboarding } from "./Onboarding";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function renderWith(status: number, onDone = vi.fn()) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "x" }), { status })));
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => createRoot(host).render(createElement(I18nProvider, null, createElement(Onboarding, { onDone }))));
  return host;
}

function phoneWidth() {
  // SAFETY: isPhone only reads .matches
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("max-width") }) as MediaQueryList);
}

describe("Onboarding engine check", () => {
  it("asks an unpaired phone to sign in instead of blaming the engines", async () => {
    const host = await renderWith(401);
    expect(host.textContent).toContain("Sign in to this PC");
    expect(host.textContent).toContain("Settings → Phone link");
    expect(host.textContent).not.toContain("couldn't check the AI engines");
  });

  it("opens a paired phone straight to the chat", async () => {
    phoneWidth();
    const onDone = vi.fn();
    const host = await renderWith(200, onDone);
    expect(onDone).toHaveBeenCalledOnce();
    expect(host.textContent).toBe("");
  });

  it("still asks an unpaired phone to sign in, and welcomes a first launch of the desktop app", async () => {
    phoneWidth();
    expect((await renderWith(401)).textContent).toContain("Sign in to this PC");
    vi.stubGlobal("ogb", { platform: "win32" });
    const onDone = vi.fn();
    expect((await renderWith(200, onDone)).textContent).toContain("Welcome to Wink");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("still reports a real engine check failure", async () => {
    const host = await renderWith(500);
    expect(host.textContent).toContain("Wink couldn't check the AI engines on this computer.");
    expect(host.textContent).not.toContain("Sign in to this PC");
  });
});
