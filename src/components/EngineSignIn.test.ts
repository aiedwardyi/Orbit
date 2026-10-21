import "./ProfileFields.test-dom.ts";
import { act, createElement, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider } from "@/lib/i18n";
import { StoreProvider, type InstanceInfo } from "@/state/store";
import { EngineSignIn } from "./EngineSetup";
import { EngineRow as EngineRowView } from "./EnginesSettings";

function EngineRow(props: ComponentProps<typeof EngineRowView>) {
  return createElement(StoreProvider, null, createElement(EngineRowView, props));
}

let root: Root | undefined;
let host: HTMLDivElement;
const capture = { url: "https://auth.example/device", code: "ABCD-EFGH" };
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

function instance(kind = "codex", partial: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    instanceId: kind, driverKind: kind, displayName: kind,
    snapshot: { state: "available", authenticated: false },
    models: { default: "", options: [] }, cliDefault: kind,
    install: { login: { args: ["login"], deviceArgs: ["login", "--device-auth"] }, logout: ["logout"], signInCommand: `${kind} login`, docsUrl: "https://example.com/guide" },
    ...partial,
  };
}

async function render(element: ReactElement) {
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, element)));
}

async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  applyLocale("en");
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  Object.assign(window, { ogb: undefined });
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.assign(window, { ogb: undefined });
});

describe("engine sign-in row", () => {
  it("runs desktop login without opening a second browser, then cancels", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(capture));
    vi.stubGlobal("fetch", fetchMock);
    const open = vi.spyOn(window, "open");
    await render(createElement(EngineSignIn, { instance: instance() }));
    await click("Sign In");
    expect(fetchMock.mock.calls[0]).toEqual(["/api/instances/codex/sign-in", expect.objectContaining({ method: "POST", body: '{"device":false}' })]);
    expect(host.textContent).toContain("Finish in your browser");
    expect(host.textContent).toContain(capture.code);
    expect(host.querySelector("a")?.href).toBe(capture.url);
    expect(open).not.toHaveBeenCalled();
    await click("Cancel");
    expect(fetchMock.mock.calls.at(-1)).toEqual(["/api/instances/codex/sign-in", expect.objectContaining({ method: "DELETE" })]);
    expect(host.textContent).toBe("Sign In");
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes every two seconds only while waiting and connects automatically", async () => {
    const row = instance();
    const fetchMock = vi.fn(async (url: string) => json(url === "/api/instances" ? { instances: [{ ...row, snapshot: { state: "available", authenticated: true } }] } : capture));
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineSignIn, { instance: row }));
    await click("Sign In");
    await act(async () => vi.advanceTimersByTimeAsync(1999));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(host.textContent).toBe("Connected");
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resets the pending flow and stops polling when switching engines", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(capture));
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineSignIn, { instance: instance() }));
    await click("Sign In");
    expect(host.textContent).toContain(capture.code);
    await act(async () => root!.render(createElement(I18nProvider, null,
      createElement(EngineSignIn, { instance: instance("grokAgent") }))));
    expect(host.textContent).toBe("Sign In");
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await click("Sign In");
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/instances/grokAgent/sign-in");
  });

  it("clears a failed flow when switching engines", async () => {
    await render(createElement(EngineSignIn, { instance: instance("codex", { loginState: "failed" }) }));
    expect(host.textContent).toContain("Didn't finish");
    await act(async () => root!.render(createElement(I18nProvider, null,
      createElement(EngineSignIn, { instance: instance("grokAgent") }))));
    expect(host.textContent).toBe("Sign In");
  });

  it("clears the copied fallback when switching to another pending engine", async () => {
    Object.assign(window, { ogb: { platform: "win32", openEngineSignIn: vi.fn(async () => "copied" as const) } });
    vi.stubGlobal("fetch", vi.fn(async () => json({})));
    await render(createElement(EngineSignIn, { instance: instance("antigravityAgent", { install: { signInCommand: "agy" } }) }));
    await click("Sign In");
    expect(host.querySelector("code")?.textContent).toBe("agy");
    await act(async () => root!.render(createElement(I18nProvider, null,
      createElement(EngineSignIn, { instance: instance("grokAgent", { loginState: "pending", loginCapture: capture }) }))));
    expect([...host.querySelectorAll("code")].map((node) => node.textContent)).toEqual([capture.code]);
  });

  it("ignores the previous engine's late start response after switching", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    await render(createElement(EngineSignIn, { instance: instance() }));
    await click("Sign In");
    await act(async () => root!.render(createElement(I18nProvider, null,
      createElement(EngineSignIn, { instance: instance("grokAgent", { loginState: "pending" }) }))));
    await act(async () => finish(json(capture)));
    expect(host.querySelector("code, a")).toBeNull();
    expect(host.textContent).toContain("Cancel");
  });

  it.each(["codex", "grokAgent", "museAgent"])("uses the phone device flow for %s", async (kind) => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(capture));
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineSignIn, { instance: instance(kind) }));
    await click("Sign In");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ body: '{"device":true}' });
    expect(host.textContent).toContain(capture.code);
  });

  it.each(["claudeAgent", "antigravityAgent"])("keeps %s on the computer without relaying a code", async (kind) => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    await render(createElement(EngineSignIn, { instance: instance(kind, { install: { login: { args: ["login"] } }, loginState: "pending", loginCapture: capture }) }));
    expect(host.textContent).toBe("Sign in from your computer");
    expect(host.querySelector("button, a, code")).toBeNull();
  });

  it("opens the agy terminal with its id and polls until connected", async () => {
    const openEngineSignIn = vi.fn(async () => "running" as const);
    Object.assign(window, { ogb: { platform: "win32", openEngineSignIn } });
    const row = instance("antigravityAgent", { install: { signInCommand: "agy" } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url === "/api/instances" ? { instances: [{ ...row, snapshot: { state: "available", authenticated: true } }] } : {})));
    await render(createElement(EngineSignIn, { instance: row }));
    await click("Sign In");
    expect(openEngineSignIn).toHaveBeenCalledExactlyOnceWith("antigravityAgent");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(host.textContent).toBe("Connected");
  });

  it("shows retry when the server reports failure or timeout", async () => {
    const row = instance();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url === "/api/instances" ? { instances: [{ ...row, loginState: "failed" }] } : capture)));
    await render(createElement(EngineSignIn, { instance: row }));
    await click("Sign In");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(host.textContent).toContain("Didn't finish. Try again.");
    expect(host.textContent).toContain("Sign In");
    expect(host.textContent).not.toContain(capture.code);
  });

  it.each(["copied", "no bridge"])("keeps waiting with the agy command after %s", async (mode) => {
    const openEngineSignIn = vi.fn(async () => "copied" as const);
    if (mode === "copied") Object.assign(window, { ogb: { platform: "win32", openEngineSignIn } });
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const row = instance("antigravityAgent", { install: { signInCommand: "agy" } });
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => json(url === "/api/instances"
      ? { instances: [{ ...row, snapshot: { state: "available", authenticated: true } }] } : {}));
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineSignIn, { instance: row }));
    await click("Sign In");
    expect(host.querySelector("code")?.textContent).toBe("agy");
    expect(host.textContent).toContain("Cancel");
    expect(host.textContent).toContain("Paste the command and press Enter.");
    expect(host.textContent).not.toContain("Didn't finish");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    if (mode === "no bridge") expect(copy).toHaveBeenCalledWith("agy");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(host.textContent).toBe("Connected");
  });

  it("keeps a still-authenticated engine Connected after failed sign-out without polling", async () => {
    const row = instance("museAgent", { snapshot: { state: "available", authenticated: true } });
    const fetchMock = vi.fn(async (url: string) => url.endsWith("/sign-out")
      ? new Response(JSON.stringify({ error: "Sign-out failed" }), { status: 502 })
      : json({ instances: [row], candidates: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineRowView, { instance: row }));
    await click("Details");
    await click("Sign Out");
    expect(host.textContent).toContain("Connected");
    expect(host.textContent).toContain("Didn't finish");
    const calls = fetchMock.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("ignores a late start response after cancellation", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((_: string, init: RequestInit) => init.method === "POST" ? new Promise<Response>((resolve) => { finish = resolve; }) : Promise.resolve(json({}))));
    await render(createElement(EngineSignIn, { instance: instance() }));
    await click("Sign In");
    await click("Cancel");
    await act(async () => finish(json(capture)));
    expect(host.textContent).toBe("Sign In");
  });

  it("holds path, terminal, copy, guide and sign-out under Details", async () => {
    let signedOut = false;
    const row = instance("codex", { snapshot: { state: "available", authenticated: true } });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/sign-out")) signedOut = true;
      return json(url.includes("cli-candidates") ? { candidates: ["codex"] } : url.startsWith("/api/instances?") ? { instances: [{ ...row, snapshot: { state: "available", authenticated: !signedOut } }] } : {});
    });
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(EngineRow, { instance: row }));
    expect(host.querySelector("input")).toBeNull();
    await click("Details");
    expect(host.querySelector("input")).not.toBeNull();
    expect(host.textContent).toContain("codex login");
    expect(host.querySelector('a[href="https://example.com/guide"]')).not.toBeNull();
    await click("Sign Out");
    expect(fetchMock).toHaveBeenCalledWith("/api/instances/codex/sign-out", expect.objectContaining({ method: "POST", body: "{}" }));
    expect(host.textContent).toContain("Sign In");
    expect(host.textContent).not.toContain("Connected");
  });

  it("never offers agy sign-out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ candidates: [] })));
    await render(createElement(EngineRow, { instance: instance("antigravityAgent", { install: { signInCommand: "agy" } }) }));
    await click("Details");
    expect(host.textContent).not.toContain("Sign Out");
  });

  it("closes a stale path picker when another client changes the CLI", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ candidates: [] })));
    const row = instance();
    await render(createElement(EngineRow, { instance: row }));
    await click("Details");
    expect(host.querySelector("input")).not.toBeNull();
    await act(async () => root!.render(createElement(I18nProvider, null, createElement(EngineRow, { instance: { ...row, cli: "other-cli" } }))));
    expect(host.querySelector("input")).toBeNull();
  });
});
