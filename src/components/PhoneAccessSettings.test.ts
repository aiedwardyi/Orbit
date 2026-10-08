// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { api } from "@/state/store";
import { PhoneAccessSettings, type RelayStatus } from "./PhoneAccessSettings";

const request = vi.fn<typeof api>();
const HOST = "abcdefghijklmnop.wink.test";
const status = (over: Partial<RelayStatus> = {}): RelayStatus => ({
  configured: true,
  enabled: true,
  state: "connected",
  host: HOST,
  relayRttMs: 31,
  certNotAfter: Date.UTC(2027, 0, 5),
  lastError: null,
  nextRetryAt: null,
  problem: null,
  ...over,
});

type Route = (init?: RequestInit) => Awaited<ReturnType<typeof api>>;

function serve(routes: Record<string, Route>) {
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    const route = routes[`${init?.method ?? "GET"} ${path}`];
    if (!route) throw new Error(`no route ${init?.method ?? "GET"} ${path}`);
    return route(init);
  });
}

afterEach(() => {
  request.mockReset();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
});

async function renderView() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(PhoneAccessSettings, { request }))));
  return { host, root };
}

const click = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const button = (host: Element, name: string) =>
  [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === name || candidate.getAttribute("aria-label") === name)!;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("PhoneAccessSettings", () => {
  it.each([
    ["en", "This PC stays awake while plugged in, so your phone can always reach it."],
    ["ko", "전원에 연결된 동안 이 PC가 절전 모드로 전환되지 않아 휴대폰에서 언제든 접속할 수 있습니다."],
  ])("shows the AC keep-awake line only while phone access is on in %s", async (locale, copy) => {
    localStorage.setItem("omb-locale", locale);
    let relay = status();
    serve({
      "GET /api/phone-relay/status": () => relay,
      "GET /api/phone/devices": () => ({ phones: [] }),
      "PUT /api/phone-relay": () => { relay = status({ enabled: !relay.enabled, state: relay.enabled ? "off" : "reconnecting" }); return relay; },
    });
    const { host, root } = await renderView();
    try {
      expect(host.textContent).toContain(copy);
      expect(host.querySelectorAll('[role="switch"]')).toHaveLength(1);
      await act(async () => click(host.querySelector('[role="switch"]')!));
      expect(host.textContent).not.toContain(copy);
      await act(async () => click(host.querySelector('[role="switch"]')!));
      expect(host.textContent).toContain(copy);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("renders nothing without a configured relay, or when the PC refuses the status", async () => {
    serve({ "GET /api/phone-relay/status": () => status({ configured: false, enabled: false, state: "off", host: null }) });
    const off = await renderView();
    expect(off.host.textContent).toBe("");
    await act(async () => off.root.unmount());

    request.mockRejectedValue(new Error("not found"));
    const refused = await renderView();
    expect(refused.host.textContent).toBe("");
    await act(async () => refused.root.unmount());
  });

  it("shows a setup card without a base and sets up from a pasted code", async () => {
    const CODE = "wks1:wink.test:wki1.invite.sig";
    const setup = vi.fn(() => status({ state: "reconnecting", host: null, base: "wink.test" }));
    serve({
      "GET /api/phone-relay/status": () => status({ available: true, configured: false, enabled: false, state: "off", host: null }),
      "POST /api/phone-relay/setup": setup,
      "GET /api/phone/devices": () => ({ phones: [] }),
    });
    const { host, root } = await renderView();
    expect(host.querySelector("[data-phone-access-setup]")).not.toBeNull();
    expect(host.textContent).toContain("Paste the setup code you were sent to reach this PC from your phone.");
    expect(host.querySelector('[role="switch"]')).toBeNull();
    await act(async () => type(host.querySelector<HTMLInputElement>('input[aria-label="Setup code"]')!, ` ${CODE} `));
    await act(async () => click(button(host, "Set up")));
    expect(setup).toHaveBeenCalledWith({ method: "POST", body: JSON.stringify({ code: CODE }) });
    expect(host.querySelector("[data-phone-access-setup]")).toBeNull();
    expect(host.textContent).toContain("Connecting to the relay...");
    await act(async () => root.unmount());
  });

  it("shows a refused setup code inline and nothing at all when the relay is forced off", async () => {
    serve({
      "GET /api/phone-relay/status": () => status({ available: true, configured: false, enabled: false, state: "off", host: null }),
      "POST /api/phone-relay/setup": () => {
        throw new Error("the setup code names an invalid relay address");
      },
    });
    const refused = await renderView();
    await act(async () => type(refused.host.querySelector<HTMLInputElement>('input[aria-label="Setup code"]')!, "wks1:localhost:wki1.a.b"));
    await act(async () => click(button(refused.host, "Set up")));
    expect(refused.host.querySelector('[role="alert"]')?.textContent).toBe("Could not set up phone access: the setup code names an invalid relay address");
    expect(refused.host.querySelector("[data-phone-access-setup]")).not.toBeNull();
    await act(async () => refused.root.unmount());

    serve({ "GET /api/phone-relay/status": () => status({ available: false, configured: false, enabled: false, state: "off", host: null }) });
    const off = await renderView();
    expect(off.host.textContent).toBe("");
    await act(async () => off.root.unmount());
  });

  it("shows why the relay client could not start next to a setup code box", async () => {
    const CODE = "wks1:wink.test:wki1.invite.sig";
    const setup = vi.fn(() => status({ state: "reconnecting", host: null, base: "wink.test" }));
    serve({
      "GET /api/phone-relay/status": () =>
        status({ available: true, base: "wink.test", state: "off", host: null, lastError: 'Dynamic require of "crypto" is not supported' }),
      "GET /api/phone/devices": () => ({ phones: [] }),
      "POST /api/phone-relay/setup": setup,
    });
    const { host, root } = await renderView();
    expect(host.querySelector("[data-phone-access-error]")?.textContent).toBe('Dynamic require of "crypto" is not supported');
    expect(host.querySelector("[data-phone-access-setup]")).not.toBeNull();
    await act(async () => type(host.querySelector<HTMLInputElement>('input[aria-label="Setup code"]')!, CODE));
    await act(async () => click(button(host, "Set up")));
    expect(setup).toHaveBeenCalledWith({ method: "POST", body: JSON.stringify({ code: CODE }) });
    expect(host.querySelector("[data-phone-access-setup]")).toBeNull();
    expect(host.textContent).toContain("Connecting to the relay...");
    await act(async () => root.unmount());
  });

  it("names a used, expired or failed setup code in plain words", async () => {
    let answer = "invite-used";
    serve({
      "GET /api/phone-relay/status": () => status({ available: true, configured: false, enabled: false, state: "off", host: null }),
      "POST /api/phone-relay/setup": () => {
        throw new Error(answer);
      },
    });
    const { host, root } = await renderView();
    await act(async () => type(host.querySelector<HTMLInputElement>('input[aria-label="Setup code"]')!, "wks1:wink.test:wki1.invite.sig"));
    for (const [code, text] of [
      ["invite-used", "This setup code was already used. Ask for a new one."],
      ["invite-expired", "This setup code has expired. Ask for a new one."],
      ["enroll-failed", "Could not set up phone access. Try again, or ask for a new setup code."],
    ]) {
      answer = code;
      await act(async () => click(button(host, "Set up")));
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(text);
    }
    await act(async () => root.unmount());
  });

  it("clears a refusal as soon as the code is edited, in either setup box", async () => {
    for (const [relay, route] of [
      [status({ available: true, configured: false, enabled: false, state: "off", host: null }), "POST /api/phone-relay/setup"],
      [status({ state: "enrolling", host: null }), "POST /api/phone-relay/enroll"],
    ] as const) {
      serve({
        "GET /api/phone-relay/status": () => relay,
        "GET /api/phone/devices": () => ({ phones: [] }),
        [route]: () => {
          throw new Error("the setup code names an invalid relay address");
        },
      });
      const { host, root } = await renderView();
      const input = host.querySelector("input")!;
      await act(async () => type(input, "wks1:localhost:wki1.a.b"));
      await act(async () => click(host.querySelector('button[type="submit"]')!));
      expect(host.querySelector('[role="alert"]'), route).not.toBeNull();
      await act(async () => type(input, "wks1:wink.test:wki1.a.b"));
      expect(host.querySelector('[role="alert"]'), route).toBeNull();
      await act(async () => root.unmount());
    }
  });

  it("takes a setup code in the retry box", async () => {
    const CODE = "wks1:wink.test:wki1.invite.sig";
    const enroll = vi.fn(() => status({ base: "wink.test" }));
    serve({
      "GET /api/phone-relay/status": () => status({ state: "enrolling", host: null, base: "wink.test" }),
      "GET /api/phone/devices": () => ({ phones: [] }),
      "POST /api/phone-relay/enroll": enroll,
    });
    const { host, root } = await renderView();
    await act(async () => type(host.querySelector<HTMLInputElement>('input[aria-label="Setup code"]')!, CODE));
    await act(async () => click(button(host, "Set up")));
    expect(enroll).toHaveBeenCalledWith({ method: "POST", body: JSON.stringify({ invite: CODE }) });
    expect(host.querySelector('input[aria-label="Setup code"]')).toBeNull();
    expect(host.querySelector("[data-phone-access-relay]")?.textContent).toBe("Relay: wink.test");
    await act(async () => root.unmount());
  });

  it("turns phone access on", async () => {
    const put = vi.fn(() => status({ state: "reconnecting" }));
    serve({ "GET /api/phone-relay/status": () => status({ enabled: false, state: "off", host: null }), "PUT /api/phone-relay": put, "GET /api/phone/devices": () => ({ phones: [] }) });
    const { host, root } = await renderView();
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).not.toContain("Paired phones");
    await act(async () => click(toggle));
    expect(put).toHaveBeenCalledWith({ method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("Connecting to the relay...");
    await act(async () => root.unmount());
  });

  it("asks for a setup code again after a refused one, by the same name", async () => {
    const enroll = vi.fn(() => {
      throw new Error("invite-used");
    });
    serve({
      "GET /api/phone-relay/status": () => status({ state: "enrolling", host: null }),
      "GET /api/phone/devices": () => ({ phones: [] }),
      "POST /api/phone-relay/enroll": enroll,
    });
    const { host, root } = await renderView();
    expect(host.querySelector("[data-phone-access-state]")?.textContent).toBe("Paste the setup code you were sent to reach this PC from your phone.");
    expect(host.textContent).not.toMatch(/invite|join/i);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Setup code"]')!;
    await act(async () => type(input, " wki1.invite.sig "));
    await act(async () => click(button(host, "Set up")));
    expect(enroll).toHaveBeenCalledWith({ method: "POST", body: JSON.stringify({ invite: "wki1.invite.sig" }) });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("This setup code was already used. Ask for a new one.");
    await act(async () => root.unmount());
  });

  it("shows the relay's own error when no known problem explains it", async () => {
    serve({
      "GET /api/phone-relay/status": () => status({ state: "reconnecting", lastError: "connection to relay closed", nextRetryAt: Date.now() + 9_500 }),
      "GET /api/phone/devices": () => ({ phones: [] }),
    });
    const { host, root } = await renderView();
    expect(host.querySelector("[data-phone-access-state]")?.textContent).toMatch(/^Relay unreachable, retrying in (9|10)s$/);
    expect(host.querySelector("[data-phone-access-error]")?.textContent).toBe("connection to relay closed");
    await act(async () => root.unmount());
  });

  it("counts a retry down from when it was scheduled, however long Settings has been open", async () => {
    vi.useFakeTimers();
    let relay = status();
    serve({ "GET /api/phone-relay/status": () => relay, "GET /api/phone/devices": () => ({ phones: [] }) });
    const { host, root } = await renderView();
    const state = () => host.querySelector("[data-phone-access-state]")?.textContent;
    try {
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      relay = status({ state: "reconnecting", lastError: "connection to relay closed", nextRetryAt: Date.now() + 9_500 });
      await act(() => vi.advanceTimersByTimeAsync(3_000));
      expect(state()).toBe("Relay unreachable, retrying in 7s");
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(state()).toBe("Relay unreachable, retrying in 6s");
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it("warns about a failing certificate renewal while still connected", async () => {
    serve({
      "GET /api/phone-relay/status": () => status({ lastError: "certificate request failed: CA did not answer in time" }),
      "GET /api/phone/devices": () => ({ phones: [] }),
    });
    const { host, root } = await renderView();
    expect(host.querySelector("[data-phone-access-state]")?.textContent).toBe("Ready. Paired phones can reach this PC.");
    expect(host.querySelector("[data-phone-access-error]")?.textContent).toBe(
      "Certificate renewal failed, will retry: certificate request failed: CA did not answer in time",
    );
    await act(async () => root.unmount());
  });

  it("explains a superseded address and an unknown certificate", async () => {
    serve({
      "GET /api/phone-relay/status": () => status({ state: "rejected", problem: "superseded", lastError: "superseded: this phone address is in use on another computer" }),
      "GET /api/phone/devices": () => ({ phones: [] }),
    });
    const superseded = await renderView();
    expect(superseded.host.querySelector('[role="alert"]')?.textContent).toBe(
      "This phone address is in use on another computer. Turn phone access off and on here to take it back.",
    );
    expect(button(superseded.host, "Add a phone")).toBeUndefined();
    await act(async () => superseded.root.unmount());

    serve({
      "GET /api/phone-relay/status": () => status({ problem: "unknown-certificate", lastError: "CT log shows a certificate for x" }),
      "GET /api/phone/devices": () => ({ phones: [] }),
    });
    const warned = await renderView();
    expect(warned.host.querySelector('[role="alert"]')?.textContent).toMatch(/^Certificate warning: /);
    await act(async () => warned.root.unmount());
  });

  it("adds a phone with a QR and a 6 digit code, and cancels it", async () => {
    const url = `https://${HOST}/pair#k=wkp_${"x".repeat(43)}`;
    const cancel = vi.fn(() => ({ ok: true }));
    serve({
      "GET /api/phone-relay/status": () => status(),
      "GET /api/phone/devices": () => ({ phones: [] }),
      "POST /api/phone/pairing": () => ({ url, code: "123456", expiresAt: Date.now() + 120_000 }),
      "DELETE /api/phone/pairing": cancel,
    });
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const { host, root } = await renderView();
    await act(async () => click(button(host, "Add a phone")));
    const qr = host.querySelector('[aria-label="Phone pairing QR code"]');
    expect(qr?.querySelector("svg")).not.toBeNull();
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    expect(scroll.mock.contexts).toEqual([qr?.parentElement]);
    expect(host.querySelector("[data-pairing-code]")?.textContent).toBe("123456");
    expect(host.textContent).toMatch(/Expires in [12]:\d\d/);
    expect(host.textContent).not.toContain("wkp_");
    await act(async () => click(button(host, "Cancel")));
    expect(cancel).toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Phone pairing QR code"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("lists paired phones and removes one", async () => {
    const remove = vi.fn(() => ({ ok: true }));
    serve({
      "GET /api/phone-relay/status": () => status(),
      "GET /api/phone/devices": () => ({
        phones: [
          { id: "p1", name: "Pixel", createdAt: Date.UTC(2026, 9, 1), lastSeenAt: Date.UTC(2026, 9, 6) },
          { id: "p2", name: "iPhone", createdAt: Date.UTC(2026, 9, 2), lastSeenAt: Date.UTC(2026, 9, 7) },
        ],
      }),
      "DELETE /api/phone/devices/p1": remove,
    });
    const { host, root } = await renderView();
    expect(host.textContent).toContain("Pixel");
    await act(async () => click(button(host, "Remove Pixel")));
    expect(remove).toHaveBeenCalledWith({ method: "DELETE" });
    expect(host.textContent).not.toContain("Pixel");
    expect(host.textContent).toContain("iPhone");
    await act(async () => root.unmount());
  });

  it("keeps the address and certificate under Advanced", async () => {
    serve({ "GET /api/phone-relay/status": () => status(), "GET /api/phone/devices": () => ({ phones: [] }) });
    const { host, root } = await renderView();
    const details = host.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Advanced");
    expect(details.textContent).toContain(HOST);
    expect(details.textContent).toContain("31 ms");
    await act(async () => root.unmount());
  });

  it("speaks Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    serve({ "GET /api/phone-relay/status": () => status(), "GET /api/phone/devices": () => ({ phones: [] }) });
    const { host, root } = await renderView();
    expect(host.textContent).toContain("어디서나 휴대폰 접속");
    expect(button(host, "휴대폰 추가")).toBeDefined();
    await act(async () => root.unmount());
  });
});
