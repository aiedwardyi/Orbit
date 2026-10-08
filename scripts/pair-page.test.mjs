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
  return { help: $("help"), form: $("form"), status: $("status") };
}

afterEach(() => {
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
    ["en", en],
    ["ko", ko],
  ])("names the Settings button that makes a new code (%s)", async (locale, catalog) => {
    localStorage.setItem("omb-locale", locale);
    for (const error of ["no-pairing", "too-many-attempts", "something-else"]) {
      const page = open("/pair#k=wkp_token", async () => new Response(JSON.stringify({ error }), { status: 409 }));
      await vi.waitFor(() => expect(page.status.className).toBe("status error"));
      expect(page.status.textContent, error).toContain(catalog["settings.phoneAccess.addPhone"]);
      expect(page.help.hidden).toBe(false);
      expect(page.form.hidden).toBe(false);
    }
  });
});
