// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HTML = readFileSync(join(ROOT, "site/signin/index.html"), "utf8");
const SCRIPT = readFileSync(join(ROOT, "site/signin/signin.js"), "utf8");
const MARKUP = HTML.slice(HTML.indexOf("<main>"), HTML.indexOf("</main>") + "</main>".length);

const CLIENT = "test-client.apps.googleusercontent.com";
const BASE = "wink.edwardyi.dev";
const LABEL_A = "aaaaaaaaaaaaaaaa";
const LABEL_B = "bbbbbbbbbbbbbbbb";
const M = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NONCE = "B63Cih-MfFXEza9EFx1F5hxPxyw7HsmG35Odfsi7nG0";
const DIR_TOKEN = "dir-token";
const PC_TOKEN = "pc-token";
const EMPTY = "Sign in with Google in Wink on your PC first: Settings, Sync.";
const OFFLINE = "Could not reach your PC. Check your connection and try again.";
const GOOGLE_DOWN = "Could not load Google sign-in. Check your connection and try again.";
const GIS_BOOM = "gis-initialize-blew-up";
const LAST_PC = "wink-signin-pc";

interface Pc {
  label: string;
  name: string;
}

interface GisResponse {
  credential: string;
}

interface GisInit {
  client_id: string;
  callback: (response: GisResponse) => void;
  nonce: string;
  auto_select: boolean;
  ux_mode: string;
}

interface GisMoment {
  isNotDisplayed: () => boolean;
  isSkippedMoment: () => boolean;
  isDismissedMoment: () => boolean;
  getDismissedReason: () => string;
}

interface FetchCall {
  url: string;
  method: string;
  authorization: string;
  body: string;
}

const inits: GisInit[] = [];
const prompts: Array<(moment: GisMoment) => void> = [];
const calls: FetchCall[] = [];
let renders = 0;

function installGoogle(gisError?: string): void {
  inits.length = 0;
  prompts.length = 0;
  renders = 0;
  vi.stubGlobal("google", {
    accounts: {
      id: {
        initialize(options: GisInit): void {
          if (gisError) throw new Error(gisError);
          inits.push(options);
        },
        renderButton(): void {
          renders += 1;
        },
        prompt(listener: (moment: GisMoment) => void): void {
          prompts.push(listener);
        },
        cancel(): void {},
      },
    },
  });
}

function installFetch(body: Pc[] | "fail"): void {
  calls.length = 0;
  vi.stubGlobal("fetch", (input: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    calls.push({
      url: input,
      method: init.method ?? "",
      authorization: headers.get("authorization") ?? "",
      body: init.body == null ? "" : String(init.body),
    });
    if (body === "fail") return Promise.reject(new Error("offline"));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
}

function open(url: string, body: Pc[] | "fail", gisError?: string): void {
  document.body.innerHTML = MARKUP;
  history.replaceState(null, "", url);
  vi.stubGlobal("WINK_SIGNIN", { clientId: CLIENT, base: BASE });
  installGoogle(gisError);
  installFetch(body);
  runInThisContext(SCRIPT);
}

function hiddenMoment(): GisMoment {
  return {
    isNotDisplayed: () => true,
    isSkippedMoment: () => false,
    isDismissedMoment: () => false,
    getDismissedReason: () => "",
  };
}

function fetchSaw(token: string): boolean {
  return calls.some((call) => `${call.url} ${call.authorization} ${call.body}`.includes(token));
}

const pair = (label: string, suffix: string) => `https://${label}.${BASE}/pair${suffix}`;

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

describe("phone sign-in page", () => {
  it("ships a strict page with no inline script", () => {
    expect(HTML).toContain("script-src 'self' https://accounts.google.com/gsi/client");
    expect(HTML).toContain("connect-src https://relay.wink.edwardyi.dev");
    expect(HTML).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(HTML).not.toContain("unsafe-inline");
    const workflow = readFileSync(join(ROOT, ".github/workflows/pages.yml"), "utf8");
    expect(workflow).toContain("branches: [review-base]");
    expect(workflow).toContain('"site/**"');
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("pages: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).toContain("WINK_GOOGLE_WEB_CLIENT_ID");
    expect(workflow).toContain("WINK_RELAY_BASE");
    expect(workflow).toContain('requested || "wink.edwardyi.dev"');
  });

  it("allows the GSI connect target and only the relay besides it", () => {
    const policy =
      "default-src 'none'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' https://accounts.google.com/gsi/style; img-src 'self'; connect-src https://relay.wink.edwardyi.dev https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
    expect(HTML).toContain(policy);
    const relay = "https://relay.example.dev";
    const shipped = HTML.replaceAll("https://relay.wink.edwardyi.dev", relay);
    expect(shipped).toContain(policy.replaceAll("https://relay.wink.edwardyi.dev", relay));
    expect(shipped).not.toContain("https://relay.wink.edwardyi.dev");
  });

  it("links to the privacy policy", () => {
    expect(HTML).toContain("Reach Wink on your PC from this phone.");
    expect(HTML).toContain('<a class="privacy" href="/privacy">Privacy</a>');
  });

  it("sends a cold start with one PC straight to that PC", async () => {
    open("/signin", [{ label: LABEL_A, name: "Home" }]);
    expect(prompts).toHaveLength(0);
    expect(renders).toBe(1);
    expect(inits[0]?.auto_select).toBe(false);
    expect(inits[0]?.client_id).toBe(CLIENT);
    expect(inits[0]?.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_A, "?g=1")));
    expect(calls).toEqual([
      {
        url: `https://relay.${BASE}/v1/pcs`,
        method: "GET",
        authorization: `Bearer ${DIR_TOKEN}`,
        body: "",
      },
    ]);
    expect(location.href).not.toContain(DIR_TOKEN);
    expect(localStorage.getItem(LAST_PC)).toBe(LABEL_A);
  });

  it("lists several PCs by name and remembers the pick", async () => {
    open("/signin", [
      { label: LABEL_B, name: "Zed" },
      { label: LABEL_A, name: "Ada" },
    ]);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    expect(location.href).not.toContain("/pair");
    const buttons = [...document.querySelectorAll("#list button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Ada", "Zed"]);
    buttons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(location.href).toBe(pair(LABEL_A, "?g=1"));
    expect(localStorage.getItem(LAST_PC)).toBe(LABEL_A);
  });

  it("skips the list when the remembered PC is still signed in", async () => {
    localStorage.setItem(LAST_PC, LABEL_B);
    open("/signin", [
      { label: LABEL_A, name: "Ada" },
      { label: LABEL_B, name: "Zed" },
    ]);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, "?g=1")));
    expect(document.querySelectorAll("#list button")).toHaveLength(0);
  });

  it("asks again when the remembered PC is gone", async () => {
    localStorage.setItem(LAST_PC, "cccccccccccccccc");
    open("/signin", [
      { label: LABEL_A, name: "Ada" },
      { label: LABEL_B, name: "Zed" },
    ]);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.querySelectorAll("#list button")).toHaveLength(2));
    expect(location.href).not.toContain("/pair");
  });

  it("forwards the return leg only to a listed label, and never fetches the PC token", async () => {
    const expected = createHash("sha256").update(`wink-gpair/1\0${LABEL_B}\0${M}`).digest("base64url");
    expect(expected).toBe(NONCE);
    open(`/signin?pc=${LABEL_B}&m=${M}`, [
      { label: LABEL_A, name: "Ada" },
      { label: LABEL_B, name: "Zed" },
    ]);
    expect(inits[0]?.auto_select).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(renders).toBe(0);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(inits).toHaveLength(2));
    expect(inits[1]?.nonce).toBe(NONCE);
    expect(inits[1]?.auto_select).toBe(true);
    expect(renders).toBe(0);
    inits[1]?.callback({ credential: PC_TOKEN });
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, `#g=${PC_TOKEN}`)));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(`Bearer ${DIR_TOKEN}`);
    expect(fetchSaw(PC_TOKEN)).toBe(false);
    expect(location.href).not.toContain(DIR_TOKEN);
  });

  it("shows the button when auto_select does not fire", async () => {
    open(`/signin?pc=${LABEL_B}&m=${M}`, [{ label: LABEL_B, name: "Zed" }]);
    prompts[0]?.(hiddenMoment());
    expect(renders).toBe(1);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    prompts[1]?.(hiddenMoment());
    expect(renders).toBe(2);
    inits[1]?.callback({ credential: PC_TOKEN });
    await vi.waitFor(() => expect(location.href).toBe(pair(LABEL_B, `#g=${PC_TOKEN}`)));
    expect(fetchSaw(PC_TOKEN)).toBe(false);
  });

  it("does not forward a return leg to a PC that is not listed", async () => {
    open(`/signin?pc=${LABEL_A}&m=${M}`, [{ label: LABEL_B, name: "Zed" }]);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe("That PC is not signed in to this Google account."));
    expect(inits).toHaveLength(1);
    expect(location.href).not.toContain("/pair");
    expect(calls).toHaveLength(1);
  });

  it.each(["short", "AAAAAAAAAAAAAAAA", "aaaaaaaaaaaaaaa0", "aaaaaaaaaaaaaaaa.evil"])("refuses a bad label (%s)", (pc) => {
    open(`/signin?pc=${encodeURIComponent(pc)}&m=${M}`, [{ label: LABEL_A, name: "Home" }]);
    expect(inits).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(document.getElementById("status")?.textContent).toBe("That PC link is not valid.");
    expect(location.href).not.toContain("/pair");
  });

  it("drops a directory label that is not a relay label", async () => {
    open("/signin", [{ label: "not-a-label", name: "Nope" }]);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(EMPTY));
    expect(location.href).not.toContain("/pair");
  });

  it("shows the empty-list copy", async () => {
    open("/signin", []);
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(EMPTY));
    expect(location.href).not.toContain("/pair");
  });

  it("shows the offline copy when the relay cannot be reached", async () => {
    open("/signin", "fail");
    inits[0]?.callback({ credential: DIR_TOKEN });
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(OFFLINE));
    expect(location.href).not.toContain("/pair");
  });

  it("shows the generic error when a cold start is rejected", async () => {
    open("/signin", [], GIS_BOOM);
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(GOOGLE_DOWN));
    expect(document.getElementById("status")?.className).toBe("status error");
    expect(document.body.textContent).not.toContain(GIS_BOOM);
  });

  it("shows the generic error when a return leg is rejected", async () => {
    open(`/signin?pc=${LABEL_B}&m=${M}`, [{ label: LABEL_B, name: "Zed" }], GIS_BOOM);
    await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(GOOGLE_DOWN));
    expect(document.getElementById("status")?.className).toBe("status error");
    expect(document.body.textContent).not.toContain(GIS_BOOM);
  });
});
