// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en, ko } from "../src/lib/i18n-catalog.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "public/pair.html"), "utf8");
const MARKUP = SOURCE.slice(SOURCE.indexOf("<main>"), SOURCE.indexOf("</main>") + "</main>".length);
const SCRIPT = SOURCE.slice(SOURCE.indexOf("<script>") + "<script>".length, SOURCE.indexOf("</script>"));

/** Runs public/pair.html at `url`; `answer` replies to its pairing request. */
function open(url, answer = () => new Promise(() => {})) {
  document.body.innerHTML = MARKUP;
  history.replaceState(null, "", url);
  vi.stubGlobal("fetch", vi.fn(answer));
  runInThisContext(SCRIPT);
  const $ = (id) => document.getElementById(id);
  return { help: $("help"), form: $("form"), status: $("status"), google: $("google"), code: $("code") };
}

/** Answers the Google start probe with `start` and the sign-in POST with `signIn`. */
function googlePc({ start = 204, signIn = () => new Response("{}", { status: 200 }) } = {}) {
  return async (url, init = {}) => {
    if (url === "/api/phone/google/start" && init.method === "HEAD") return new Response(null, { status: start });
    if (url === "/api/phone/google") return signIn(init);
    return new Promise(() => {});
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("pair page", () => {
  it("shows only its progress while the QR link pairs on its own", () => {
    const page = open("/pair#k=wkp_token");
    expect(page.status.textContent).toBe("Pairing...");
    expect(page.help.hidden).toBe(true);
    expect(page.form.hidden).toBe(true);
    expect(location.hash).toBe("");
  });

  it("asks for the 6 digit code when opened without a link", () => {
    const page = open("/pair");
    expect(page.help.hidden).toBe(false);
    expect(page.help.textContent).toContain("6 digit code");
    expect(page.form.hidden).toBe(false);
  });

  it.each([
    ["en", en, "Get a new code on your PC: Settings, Connections, Phone access."],
    ["ko", ko, "PC의 설정 > 연결 > 휴대폰 접속에서 새 코드를 받으세요."],
  ])("sends a refused phone to Phone access for a new code (%s)", async (locale, catalog, next) => {
    localStorage.setItem("omb-locale", locale);
    for (const error of ["no-pairing", "too-many-attempts", "something-else"]) {
      const page = open("/pair#k=wkp_token", async () => new Response(JSON.stringify({ error }), { status: 409 }));
      await vi.waitFor(() => expect(page.status.className).toBe("status error"));
      // The PC shows Add a phone or Make a new code depending on its state, so name neither.
      expect(page.status.textContent, error).toContain(next);
      expect(page.status.textContent, error).not.toContain(catalog["settings.phoneAccess.addPhone"]);
      expect(page.help.hidden).toBe(false);
      expect(page.form.hidden).toBe(false);
    }
  });

  it("shows one Continue with Google button above the code field when the PC can take it", async () => {
    const page = open("/pair", googlePc());
    await vi.waitFor(() => expect(page.google.hidden).toBe(false));
    expect(page.google.textContent.trim()).toBe("Continue with Google");
    expect(page.google.compareDocumentPosition(page.code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelectorAll(".google")).toHaveLength(1);
    expect(page.form.hidden).toBe(false);
  });

  it("keeps the button hidden when the PC can't take a Google sign-in", async () => {
    const page = open("/pair", googlePc({ start: 409 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.google.hidden).toBe(true);
    expect(page.form.hidden).toBe(false);
  });

  it("goes to the start route from the button, and on its own with ?g=1", async () => {
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    const page = open("/pair", googlePc());
    await vi.waitFor(() => expect(page.google.hidden).toBe(false));
    expect(assign).not.toHaveBeenCalled();
    page.google.click();
    expect(assign).toHaveBeenCalledExactlyOnceWith("/api/phone/google/start");
    assign.mockClear();
    open("/pair?g=1", googlePc());
    await vi.waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("/api/phone/google/start"));
    assign.mockClear();
    open("/pair?g=1", googlePc({ start: 409 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "Google sign-in isn't ready on this PC yet. Use the code."],
    ["ko", "이 PC에서는 아직 Google 로그인을 사용할 수 없습니다. 코드를 사용하세요."],
  ])("says why after ?g=1 when the PC can't take a Google sign-in yet (%s)", async (locale, text) => {
    localStorage.setItem("omb-locale", locale);
    const page = open("/pair?g=1", googlePc({ start: 409 }));
    await vi.waitFor(() => expect(page.status.textContent).toBe(text));
    expect(page.status.className).toBe("status");
    expect(page.google.hidden).toBe(true);
    expect(page.form.hidden).toBe(false);
    const plain = open("/pair", googlePc({ start: 409 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(plain.status.textContent).toBe("");
  });

  it("reads and clears #g=, posts the token, then loads the app", async () => {
    const replace = vi.spyOn(location, "replace").mockImplementation(() => {});
    const posted = [];
    const page = open("/pair#g=id.token.sig", googlePc({ signIn: (init) => (posted.push(init), new Response("{}", { status: 200 })) }));
    expect(location.hash).toBe("");
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(posted[0].body)).toEqual({ credential: "id.token.sig", name: "Phone" });
    expect(page.status.textContent).toBe("Paired. Opening Wink...");
  });

  it("names a wrong account and offers the code field after a refused Google sign-in", async () => {
    for (const [error, text] of [["wrong-account", "Use the Google account this PC is signed in with."], ["nonce-mismatch", "Google sign-in did not work. Try again, or enter the 6 digit code."]]) {
      const page = open("/pair#g=id.token.sig", googlePc({ signIn: () => new Response(JSON.stringify({ error }), { status: 403 }) }));
      await vi.waitFor(() => expect(page.status.className).toBe("status error"));
      expect(page.status.textContent).toBe(text);
      expect(page.form.hidden).toBe(false);
    }
  });
});
