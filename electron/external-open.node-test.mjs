import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { safeExternalUrl } from "./external-open.mjs";

test("allows only http and https for shell.openExternal", () => {
  assert.equal(safeExternalUrl("https://example.com/docs"), "https://example.com/docs");
  assert.equal(safeExternalUrl("http://127.0.0.1:8799/"), "http://127.0.0.1:8799/");
  assert.equal(safeExternalUrl("file:///tmp/server.log"), null);
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("smb://evil/share"), null);
  assert.equal(safeExternalUrl("not a url"), null);
});

test("main window open handler never opens raw file URLs or the server log", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = main.indexOf("win.webContents.setWindowOpenHandler");
  const end = main.indexOf("win.webContents.on(\"did-finish-load\"");
  assert.ok(start >= 0 && end > start, "window-open handler anchors missing or reordered in main.mjs");
  const handler = main.slice(start, end);
  assert.match(handler, /safeExternalUrl/);
  assert.equal(handler.includes("shell.openExternal(url)"), false);
  assert.equal(main.includes("pathToFileURL(serverLogPath)"), false);
  assert.match(main, /redactSecretsInLine/);
});
