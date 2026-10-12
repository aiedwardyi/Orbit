// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HTML = readFileSync(join(ROOT, "site/team/index.html"), "utf8");
const SCRIPT = readFileSync(join(ROOT, "site/team/team.js"), "utf8");
const MARKUP = HTML.slice(HTML.indexOf("<main>"), HTML.indexOf("</main>") + "</main>".length);

const CLIENT = "test-client.apps.googleusercontent.com";
const BASE = "wink.edwardyi.dev";
const TOKEN = "owner-token";
const NOW = Date.parse("2026-10-12T06:00:00Z");
const DAYS = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 8, 29 + i)).toISOString().slice(0, 10));

const FIXTURE = {
  now: NOW,
  days: DAYS,
  pcs: [
    {
      label: "aaaaaaaaaaaaaaaa",
      name: "Home",
      online: true,
      lastSeen: NOW,
      firstSeen: NOW - 20 * 86_400_000,
      hours: [0, 2, 4.5, 0, 0, 8, 9, 6, 0, 3, 5, 7, 1, 3.25],
      phone: [...Array.from({ length: 13 }, () => ({ count: 0, minutes: 0 })), { count: 2, minutes: 74 }],
    },
    {
      label: "bbbbbbbbbbbbbbbb",
      name: "",
      online: false,
      lastSeen: NOW - 3 * 3_600_000,
      firstSeen: NOW - 5 * 86_400_000,
      hours: Array.from({ length: 14 }, () => 0),
      phone: Array.from({ length: 14 }, () => ({ count: 0, minutes: 0 })),
    },
  ],
};

interface GisInit {
  client_id: string;
  callback: (response: { credential: string }) => void;
}

const inits: GisInit[] = [];
const calls: { url: string; authorization: string }[] = [];

function open(reply: { status: number; body: unknown } | "fail"): void {
  document.body.innerHTML = MARKUP;
  inits.length = 0;
  calls.length = 0;
  vi.stubGlobal("WINK_SIGNIN", { clientId: CLIENT, base: BASE });
  vi.stubGlobal("google", {
    accounts: {
      id: {
        initialize: (options: GisInit) => inits.push(options),
        renderButton(): void {},
        prompt(): void {},
        cancel(): void {},
      },
    },
  });
  vi.stubGlobal("fetch", (input: string, init: RequestInit): Promise<Response> => {
    calls.push({ url: input, authorization: new Headers(init.headers).get("authorization") ?? "" });
    if (reply === "fail") return Promise.reject(new Error("offline"));
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
  });
  runInThisContext(SCRIPT);
}

const rows = () =>
  [...document.querySelectorAll("#team tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("team page", () => {
  it("loads only its own files and Google's sign-in script", () => {
    const scripts = [...HTML.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual(["https://accounts.google.com/gsi/client", "/signin/config.js", "/team/team.js"]);
    expect(HTML).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(HTML).toContain(
      "default-src 'none'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' https://accounts.google.com/gsi/style; img-src 'self'; connect-src https://relay.wink.edwardyi.dev https://accounts.google.com/gsi/;",
    );
    expect(HTML).toContain('<meta name="referrer" content="strict-origin" />');
    expect([...HTML.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(["/team/team.css", "/privacy"]);
    const workflow = readFileSync(join(ROOT, ".github/workflows/pages.yml"), "utf8");
    expect(workflow).toContain('readFileSync("site/team/index.html", "utf8").replaceAll("https://relay.wink.edwardyi.dev", relay)');
  });

  it("renders the table from the owner's stats", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    open({ status: 200, body: FIXTURE });
    expect(inits[0]?.client_id).toBe(CLIENT);
    inits[0]?.callback({ credential: TOKEN });
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    vi.useRealTimers();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(new RegExp(`^https://relay\\.${BASE.replaceAll(".", "\\.")}/v1/team\\?tz=-?\\d+$`));
    expect(calls[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(rows()).toEqual([
      ["Home", "Online", "3.3h", "", "2 · 1h 14m"],
      ["bbbbbbbbbbbbbbbb", "3h ago", "0h", "", "-"],
    ]);
    expect(document.querySelector("#team")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelectorAll(".dot.on")).toHaveLength(1);
    const bars = document.querySelectorAll("#team tbody tr:first-child .bar span");
    expect(bars).toHaveLength(14);
    expect([...bars].filter((bar) => bar.getAttribute("style"))).toHaveLength(10);
    expect(bars[13]?.getAttribute("title")).toBe("2026-10-12 3.3h");
    expect(document.querySelector("#google")?.hasAttribute("hidden")).toBe(true);
  });

  it("says when the account is not the owner, and when the relay is down", async () => {
    open({ status: 403, body: { error: "not-owner" } });
    inits[0]?.callback({ credential: TOKEN });
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("This page is only for the relay's owner."));
    expect(document.querySelector("#team")?.hasAttribute("hidden")).toBe(true);

    open("fail");
    inits[0]?.callback({ credential: TOKEN });
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("Could not reach the relay. Try again."));
  });
});
