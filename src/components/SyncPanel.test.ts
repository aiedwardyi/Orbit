// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { googleSyncRoute, type GoogleSyncStatus } from "../../server/google-sync.ts";
import { requestCredentials } from "../../server/phone-auth.ts";
import { I18nProvider } from "@/lib/i18n";
import { SyncPanel } from "./SyncPanel";

type Reply = object | Promise<object>;
type SignIn = { ok: true; email: string } | { ok: false; error: string };
type GoogleBody = {
  state: string;
  email: string | null;
  boundEmail: string | null;
  join: { first: boolean; pcs: number } | null;
  progress: { done: number; total: number } | null;
  lastSyncAt: number | null;
  move?: true;
  problem?: string;
};
type FolderBody = {
  configured: boolean;
  folder: string | null;
  status: string;
  operations: number;
  invalidFiles: string[];
  lastSyncAt: number | null;
  syncChats: boolean;
};

const routes = new Map<string, (init?: RequestInit) => Reply>();
const calls: string[] = [];

// Mirrors the server: a handler that throws answers 400 with its message, an unknown route answers 404 "no route"
async function fakeFetch(path: string, init?: RequestInit) {
  const key = `${init?.method ?? "GET"} ${path}`;
  calls.push(init?.body ? `${key} ${init.body}` : key);
  const handler = routes.get(key);
  if (!handler) return Response.json({ error: `no route: ${key}` }, { status: 404 });
  try {
    return Response.json(await handler(init));
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 400 });
  }
}

const PICKED = "G:\\My Drive\\Wink Sync";
const GOOGLE = "GET /api/google-sync";
const FOLDER = "GET /api/profile-sync";

const google = (state: string, extra: Partial<GoogleBody> = {}): GoogleBody => ({
  state,
  email: "edward@example.com",
  boundEmail: null,
  join: null,
  progress: null,
  lastSyncAt: null,
  ...extra,
});

const folderStatus = (extra: Partial<FolderBody> = {}): FolderBody => ({
  configured: true,
  folder: PICKED,
  status: "up-to-date",
  operations: 3,
  invalidFiles: [],
  lastSyncAt: null,
  syncChats: false,
  ...extra,
});

function ogbStub() {
  const account = {
    signIn: vi.fn<() => Promise<SignIn>>(async () => ({ ok: true, email: "edward@example.com" })),
    cancel: vi.fn(async () => undefined),
    signOut: vi.fn(async () => ({ ok: true as const })),
  };
  const ogb = { platform: "win32", googleAccount: account, pickFolder: vi.fn<(start?: string) => Promise<string | null>>(async () => PICKED) };
  vi.stubGlobal("ogb", ogb);
  return { ogb, account };
}

let root: Root | null = null;

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(SyncPanel))));
  return host;
}

const line = (host: HTMLElement) => host.querySelector('[role="status"]')?.textContent ?? null;
const buttons = (host: HTMLElement) => [...host.querySelectorAll("button")].map((button) => button.textContent);
const button = (host: HTMLElement, label: string) => {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`no "${label}" button in ${buttons(host).join(", ")}`);
  return found;
};
const click = (el: HTMLElement) => act(async () => el.click());

beforeEach(() => {
  routes.clear();
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  localStorage.setItem("omb-locale", "en");
  routes.set(GOOGLE, () => google("signed-out"));
  routes.set(FOLDER, () => folderStatus());
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("SyncPanel Google states", () => {
  const rows: [string, GoogleBody, string | null, string[]][] = [
    ["signed-out", google("signed-out", { email: null }), null, ["Sign in with Google", "Use a Drive folder instead"]],
    ["ready, no join", google("ready"), "edward@example.com", ["Start", "Sign out"]],
    ["ready, first PC", google("ready", { join: { first: true, pcs: 1 } }), "First PC on edward@example.com", ["Start", "Sign out"]],
    ["ready, joining", google("ready", { join: { first: false, pcs: 3 } }), "Joining edward@example.com · 3 PCs", ["Start", "Sign out"]],
    ["joining", google("joining", { progress: { done: 2, total: 9 } }), "Syncing 2 of 9", ["Sign out"]],
    ["syncing", google("syncing", { progress: { done: 4, total: 9 } }), "Syncing 4 of 9", ["Sign out"]],
    ["syncing without progress", google("syncing"), "Syncing…", ["Sign out"]],
    ["up-to-date", google("up-to-date"), "Up to date · edward@example.com", ["Sign out"]],
    ["offline", google("offline"), "Offline. Changes sync when you're back online.", ["Sign out"]],
    ["drive-full", google("drive-full"), "Google Drive is full. Free up space in Google Drive. Wink catches up on its own.", ["Sign out"]],
    ["drive-full during a Move", google("drive-full", { move: true }), "Google Drive is full. Free up space in Google Drive. Wink catches up on its own.", ["Sign out"]],
    ["needs-sign-in", google("needs-sign-in"), "Sign in again to keep syncing.", ["Sign in with Google", "Sign out"]],
    ["blocked", google("blocked"), "Your organization's Google admin blocked Wink.", ["Use a Drive folder instead"]],
    ["other-account", google("other-account", { boundEmail: "work@example.com" }), "This PC syncs with work@example.com.", ["Sign out"]],
    ["error", google("error"), "Sync stopped. It will try again.", ["Sign out"]],
  ];

  it.each(rows)("%s", async (_name, body, expectedLine, expectedButtons) => {
    ogbStub();
    routes.set(GOOGLE, () => body);
    const host = await mount();
    expect(line(host)).toBe(expectedLine);
    expect(buttons(host)).toEqual(expectedButtons);
    expect(host.textContent).not.toMatch(/null|undefined/);
  });

  it("shows nothing but the title and subtitle until the first read lands", async () => {
    ogbStub();
    routes.set(GOOGLE, () => new Promise<GoogleBody>(() => {}));
    const host = await mount();
    expect(host.textContent).toBe("SyncYour bots, memory and chats on all your PCs.");
    expect(buttons(host)).toEqual([]);
  });

  it("drops the help text, the chats switch and the refresh button", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("up-to-date"));
    const host = await mount();
    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(host.querySelector("p")).toBeNull();
    expect(host.innerHTML).not.toMatch(/refresh/i);
    expect(host.textContent).not.toMatch(/Shared bot setup|Sync chats|only syncs chats/);
    expect(host.textContent).toBe("SyncYour bots, memory and chats on all your PCs.Up to date · edward@example.comSign out");
  });

  it("reads Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    ogbStub();
    routes.set(GOOGLE, () => google("up-to-date"));
    const host = await mount();
    expect(line(host)).toBe("최신 상태 · edward@example.com");
    expect(buttons(host)).toEqual(["로그아웃"]);
  });

  it("says Google Drive is full in Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    ogbStub();
    routes.set(GOOGLE, () => google("drive-full"));
    const host = await mount();
    expect(line(host)).toBe("Google Drive가 가득 찼어요. Google Drive 공간을 비우면 Wink가 알아서 이어서 동기화해요.");
  });

  it("polls every 5 seconds while open and stops on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    ogbStub();
    let body = google("syncing", { progress: { done: 1, total: 4 } });
    routes.set(GOOGLE, () => body);
    const host = await mount();
    expect(line(host)).toBe("Syncing 1 of 4");
    body = google("up-to-date");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(line(host)).toBe("Up to date · edward@example.com");
    await act(async () => root?.unmount());
    root = null;
    const reads = calls.filter((call) => call === GOOGLE).length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls.filter((call) => call === GOOGLE).length).toBe(reads);
  });

  it("keeps the last state when a poll fails", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    ogbStub();
    routes.set(GOOGLE, () => google("up-to-date"));
    const host = await mount();
    routes.set(GOOGLE, () => {
      throw new Error("Failed to fetch");
    });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(line(host)).toBe("Up to date · edward@example.com");
  });
});

describe("SyncPanel actions", () => {
  it("signs in: waits for Google, then reads the new state", async () => {
    const { account } = ogbStub();
    let finish: (value: SignIn) => void = () => {};
    account.signIn.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const host = await mount();
    await click(button(host, "Sign in with Google"));
    expect(line(host)).toBe("Waiting for Google…");
    expect(buttons(host)).toEqual(["Cancel"]);
    routes.set(GOOGLE, () => google("ready", { join: { first: true, pcs: 1 } }));
    await act(async () => finish({ ok: true, email: "edward@example.com" }));
    expect(line(host)).toBe("First PC on edward@example.com");
  });

  it("shows a failed sign-in's own error on the status line", async () => {
    const { account } = ogbStub();
    account.signIn.mockResolvedValue({ ok: false, error: "Google sign-in timed out." });
    const host = await mount();
    await click(button(host, "Sign in with Google"));
    expect(line(host)).toBe("Google sign-in timed out.");
    expect(buttons(host)).toEqual(["Sign in with Google", "Use a Drive folder instead"]);
  });

  it("cancels quietly even when the pending sign-in then reports failure", async () => {
    const { account } = ogbStub();
    let finish: (value: SignIn) => void = () => {};
    account.signIn.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const host = await mount();
    await click(button(host, "Sign in with Google"));
    await click(button(host, "Cancel"));
    expect(account.cancel).toHaveBeenCalledOnce();
    expect(buttons(host)).toEqual(["Sign in with Google", "Use a Drive folder instead"]);
    await act(async () => finish({ ok: false, error: "Sign-in cancelled." }));
    expect(line(host)).toBeNull();
  });

  it("signs out, then reads the new state", async () => {
    const { account } = ogbStub();
    routes.set(GOOGLE, () => google("up-to-date"));
    const host = await mount();
    routes.set(GOOGLE, () => google("signed-out", { email: null }));
    await click(button(host, "Sign out"));
    expect(account.signOut).toHaveBeenCalledOnce();
    expect(buttons(host)).toEqual(["Sign in with Google", "Use a Drive folder instead"]);
  });

  it("starts sync and shows the state it returns", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("ready", { join: { first: true, pcs: 1 } }));
    routes.set("POST /api/google-sync/start", () => google("syncing", { progress: { done: 0, total: 5 } }));
    const host = await mount();
    await click(button(host, "Start"));
    expect(calls).toContain("POST /api/google-sync/start");
    expect(line(host)).toBe("Syncing 0 of 5");
    expect(buttons(host)).toEqual(["Sign out"]);
  });

  it("shows the error when Start is refused", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("ready", { join: { first: true, pcs: 1 } }));
    routes.set("POST /api/google-sync/start", () => {
      throw new Error("Sync is not ready to start.");
    });
    const host = await mount();
    await click(button(host, "Start"));
    expect(line(host)).toBe("Sync is not ready to start.");
  });
});

describe("SyncPanel folder view", () => {
  it("falls back to the folder view when the build has no Google route", async () => {
    ogbStub();
    routes.delete(GOOGLE);
    const host = await mount();
    expect(line(host)).toBe("Up to date · Wink Sync");
    expect(buttons(host)).toEqual(["Change folder", "Disconnect"]);
  });

  it("shows the folder view for the old folder setup", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("folder"));
    routes.set(FOLDER, () => folderStatus({ status: "waiting" }));
    const host = await mount();
    expect(line(host)).toBe("Waiting for Drive · Wink Sync");
    expect(buttons(host)).toEqual(["Change folder", "Move to Google", "Disconnect"]);
  });

  it("offers only Choose Drive folder when no folder is set", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("unavailable"));
    routes.set(FOLDER, () => folderStatus({ configured: false, folder: null, status: "disconnected" }));
    const host = await mount();
    expect(line(host)).toBe("Not connected");
    expect(buttons(host)).toEqual(["Choose Drive folder"]);
  });

  it("names a folder that needs review", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("folder"));
    routes.set(FOLDER, () => folderStatus({ status: "needs-review" }));
    expect(line(await mount())).toBe("Needs review · Wink Sync");
  });

  it("choosing a folder saves it, then turns chat sync on", async () => {
    const { ogb } = ogbStub();
    routes.set(GOOGLE, () => google("folder"));
    routes.set(FOLDER, () => folderStatus({ status: "waiting", syncChats: false }));
    routes.set("PUT /api/profile-sync", () => folderStatus({ status: "waiting" }));
    routes.set("PUT /api/profile-sync/chats", () => folderStatus({ status: "up-to-date", syncChats: true }));
    const host = await mount();
    expect(calls.filter((call) => call.startsWith("PUT"))).toEqual([]);
    await click(button(host, "Change folder"));
    expect(ogb.pickFolder).toHaveBeenCalledWith(PICKED);
    expect(calls.filter((call) => call.startsWith("PUT"))).toEqual([
      `PUT /api/profile-sync ${JSON.stringify({ folder: PICKED })}`,
      `PUT /api/profile-sync/chats ${JSON.stringify({ enabled: true })}`,
    ]);
    expect(line(host)).toBe("Up to date · Wink Sync");
  });

  it("leaves chat sync alone when the folder is not saved or the pick is cancelled", async () => {
    const { ogb } = ogbStub();
    routes.set(GOOGLE, () => google("folder"));
    routes.set("PUT /api/profile-sync", () => {
      throw new Error("Folder is not inside Google Drive.");
    });
    const host = await mount();
    await click(button(host, "Change folder"));
    expect(line(host)).toBe("Folder is not inside Google Drive.");
    expect(calls.filter((call) => call.startsWith("PUT /api/profile-sync/chats"))).toEqual([]);
    ogb.pickFolder.mockResolvedValue(null);
    await click(button(host, "Change folder"));
    expect(calls.filter((call) => call.startsWith("PUT"))).toHaveLength(1);
  });

  it("disconnects and shows the empty folder status", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("folder"));
    routes.set("DELETE /api/profile-sync", () => folderStatus({ configured: false, folder: null, status: "disconnected" }));
    const host = await mount();
    await click(button(host, "Disconnect"));
    expect(line(host)).toBe("Not connected");
    expect(buttons(host)).toEqual(["Choose Drive folder"]);
  });

  it("reveals the folder view in place and has a way back", async () => {
    ogbStub();
    routes.set(FOLDER, () => folderStatus({ configured: false, folder: null, status: "disconnected" }));
    const host = await mount();
    await click(button(host, "Use a Drive folder instead"));
    expect(line(host)).toBe("Not connected");
    expect(buttons(host)).toEqual(["Choose Drive folder", "Back"]);
    await click(button(host, "Back"));
    expect(buttons(host)).toEqual(["Sign in with Google", "Use a Drive folder instead"]);
  });

  it("reveals the folder view from a blocked org", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("blocked"));
    routes.set(FOLDER, () => folderStatus({ configured: false, folder: null, status: "disconnected" }));
    const host = await mount();
    await click(button(host, "Use a Drive folder instead"));
    expect(buttons(host)).toEqual(["Choose Drive folder", "Back"]);
  });
});

describe("SyncPanel move to Google", () => {
  it("shows Move to Google only for a configured folder when Google is available", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("folder"));
    const host = await mount();
    expect(line(host)).toBe("Up to date · Wink Sync");
    expect(buttons(host)).toEqual(["Change folder", "Move to Google", "Disconnect"]);
    const move = button(host, "Move to Google");
    const disconnect = button(host, "Disconnect");
    expect(move.className).toBe(disconnect.className);
    expect(move.className).not.toContain("font-medium");
  });

  it("hides Move to Google when no folder is configured", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("folder"));
    routes.set(FOLDER, () => folderStatus({ configured: false, folder: null, status: "disconnected" }));
    const host = await mount();
    expect(buttons(host)).toEqual(["Choose Drive folder"]);
    expect(host.textContent).not.toContain("Move to Google");
  });

  it("hides Move to Google when sign-in is unavailable", async () => {
    vi.stubGlobal("ogb", { platform: "win32", pickFolder: vi.fn(async () => PICKED) });
    routes.set(GOOGLE, () => google("folder"));
    const host = await mount();
    expect(buttons(host)).toEqual(["Change folder", "Disconnect"]);
  });

  it("hides Move to Google on a phone", async () => {
    routes.set(GOOGLE, () => google("folder"));
    const host = await mount();
    expect(line(host)).toBe("Up to date · Wink Sync");
    expect(buttons(host)).toEqual([]);
    expect(host.textContent).not.toContain("Move to Google");
  });

  it("signs in from Move to Google, and Cancel returns to the folder", async () => {
    const { account } = ogbStub();
    let finish: (value: SignIn) => void = () => {};
    account.signIn.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    routes.set(GOOGLE, () => google("folder"));
    const host = await mount();
    await click(button(host, "Move to Google"));
    expect(account.signIn).toHaveBeenCalledOnce();
    expect(line(host)).toBe("Waiting for Google…");
    expect(buttons(host)).toEqual(["Cancel"]);
    await click(button(host, "Cancel"));
    expect(account.cancel).toHaveBeenCalledOnce();
    expect(buttons(host)).toEqual(["Change folder", "Move to Google", "Disconnect"]);
    await act(async () => finish({ ok: false, error: "Sign-in cancelled." }));
    expect(line(host)).toBe("Up to date · Wink Sync");

    let finishAgain: (value: SignIn) => void = () => {};
    account.signIn.mockReturnValue(new Promise((resolve) => (finishAgain = resolve)));
    routes.set(GOOGLE, () => google("ready", { move: true, join: { first: true, pcs: 1 } }));
    await click(button(host, "Move to Google"));
    await act(async () => finishAgain({ ok: true, email: "edward@example.com" }));
    expect(line(host)).toBe("First PC on edward@example.com");
    expect(buttons(host)).toEqual(["Start", "Sign out"]);
  });

  it("posts move when Start runs for the first PC", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("ready", { move: true, join: { first: true, pcs: 1 } }));
    routes.set("POST /api/google-sync/start", () => google("syncing", { move: true, progress: { done: 0, total: 5 } }));
    const host = await mount();
    expect(line(host)).toBe("First PC on edward@example.com");
    await click(button(host, "Start"));
    expect(calls).toContain(`POST /api/google-sync/start ${JSON.stringify({ move: true })}`);
    expect(line(host)).toBe("Syncing 0 of 5");
  });

  it("posts move when Start runs while joining 3 PCs", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("ready", { move: true, join: { first: false, pcs: 3 } }));
    routes.set("POST /api/google-sync/start", () => google("joining", { move: true, progress: { done: 1, total: 4 } }));
    const host = await mount();
    expect(line(host)).toBe("Joining edward@example.com · 3 PCs");
    await click(button(host, "Start"));
    expect(calls).toContain(`POST /api/google-sync/start ${JSON.stringify({ move: true })}`);
    expect(line(host)).toBe("Syncing 1 of 4");
    expect(buttons(host)).toEqual(["Sign out"]);
  });

  it("posts no body when Start runs without a move", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("ready", { join: { first: true, pcs: 1 } }));
    routes.set("POST /api/google-sync/start", () => google("syncing", { progress: { done: 0, total: 5 } }));
    const host = await mount();
    await click(button(host, "Start"));
    expect(calls).toContain("POST /api/google-sync/start");
    expect(calls.some((call) => call.startsWith("POST /api/google-sync/start "))).toBe(false);
  });

  it("shows the refusal line and no Start for another workspace", async () => {
    ogbStub();
    routes.set(GOOGLE, () => google("ready", { move: true, join: null, problem: "Drive holds another Wink workspace." }));
    const host = await mount();
    expect(line(host)).toBe("This Google account syncs other Wink data.");
    expect(buttons(host)).toEqual(["Sign out"]);
    expect(host.textContent).not.toContain("Drive holds another");
  });

  it("returns to the folder view after signing out of a move", async () => {
    const { account } = ogbStub();
    routes.set(GOOGLE, () => google("ready", { move: true, join: { first: true, pcs: 1 } }));
    const host = await mount();
    routes.set(GOOGLE, () => google("folder", { email: null }));
    await click(button(host, "Sign out"));
    expect(account.signOut).toHaveBeenCalledOnce();
    expect(line(host)).toBe("Up to date · Wink Sync");
    expect(buttons(host)).toEqual(["Change folder", "Move to Google", "Disconnect"]);
  });

  it("keeps Change folder and Disconnect on the same calls", async () => {
    const { ogb } = ogbStub();
    routes.set(GOOGLE, () => google("folder"));
    routes.set("PUT /api/profile-sync", () => folderStatus());
    routes.set("PUT /api/profile-sync/chats", () => folderStatus({ syncChats: true }));
    routes.set("DELETE /api/profile-sync", () => folderStatus({ configured: false, folder: null, status: "disconnected" }));
    const host = await mount();
    expect(buttons(host)).toEqual(["Change folder", "Move to Google", "Disconnect"]);
    await click(button(host, "Change folder"));
    expect(ogb.pickFolder).toHaveBeenCalledWith(PICKED);
    expect(calls.filter((call) => call.startsWith("PUT"))).toEqual([
      `PUT /api/profile-sync ${JSON.stringify({ folder: PICKED })}`,
      `PUT /api/profile-sync/chats ${JSON.stringify({ enabled: true })}`,
    ]);
    await click(button(host, "Disconnect"));
    expect(calls.some((call) => call.startsWith("DELETE /api/profile-sync"))).toBe(true);
    expect(buttons(host)).toEqual(["Choose Drive folder"]);
  });

  it("reads the move action and the refusal in Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    ogbStub();
    routes.set(GOOGLE, () => google("folder"));
    const host = await mount();
    expect(buttons(host)).toEqual(["폴더 변경", "Google로 옮기기", "연결 해제"]);
    await act(async () => root?.unmount());
    root = null;
    routes.set(GOOGLE, () => google("ready", { move: true, join: null, problem: "Drive holds another Wink workspace." }));
    const refused = await mount();
    expect(line(refused)).toBe("이 Google 계정은 다른 Wink 데이터를 동기화해요.");
    expect(refused.textContent).not.toContain("Drive holds another");
  });
});

describe("SyncPanel on a phone", () => {
  it.each<[GoogleSyncStatus["state"], string]>([
    ["up-to-date", "Up to date · edward@example.com"],
    ["syncing", "Syncing…"],
    ["drive-full", "Google Drive is full. Free up space in Google Drive. Wink catches up on its own."],
    ["offline", "Offline. Changes sync when you're back online."],
    ["folder", "Up to date · Wink Sync"],
  ])("shows %s through the authenticated relay route", async (state, expected) => {
    const caller = { relay: true, ...requestCredentials(true, true, false, undefined) };
    const read = vi.fn(async () => ({ ...google(state), state }));
    const start = vi.fn(async () => { throw new Error("phone cannot start sync"); });
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      const reply = await googleSyncRoute(init?.method ?? "GET", path, caller, { read, start });
      if (!reply) return fakeFetch(path, init);
      calls.push(`${init?.method ?? "GET"} ${path}`);
      return Response.json(reply.body, { status: reply.status });
    }));
    const host = await mount();
    expect(line(host)).toBe(expected);
    expect(buttons(host)).toEqual([]);
    expect(calls).toEqual(state === "folder" ? [GOOGLE, FOLDER] : [GOOGLE]);
    expect(start).not.toHaveBeenCalled();
  });

  it("shows Not connected under the subtitle when signed out", async () => {
    routes.set(GOOGLE, () => google("signed-out", { email: null }));
    const host = await mount();
    expect(line(host)).toBe("Not connected");
    expect(buttons(host)).toEqual([]);
  });

  it("shows the status line only, with no buttons", async () => {
    routes.set(GOOGLE, () => google("up-to-date"));
    const host = await mount();
    expect(line(host)).toBe("Up to date · edward@example.com");
    expect(buttons(host)).toEqual([]);
  });

  it("says Google Drive is full, with no buttons", async () => {
    routes.set(GOOGLE, () => google("drive-full"));
    const host = await mount();
    expect(line(host)).toBe("Google Drive is full. Free up space in Google Drive. Wink catches up on its own.");
    expect(buttons(host)).toEqual([]);
  });

  it("shows the folder status line only, with no buttons", async () => {
    routes.set(GOOGLE, () => google("folder"));
    const host = await mount();
    expect(line(host)).toBe("Up to date · Wink Sync");
    expect(buttons(host)).toEqual([]);
  });
});
