import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readTerminalAppearance } from "./terminal-appearance.mjs";

const stable = ["Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"];
const preview = ["Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"];
const unpackaged = ["Microsoft", "Windows Terminal", "settings.json"];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-appearance-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    read: (options = {}) => readTerminalAppearance({ env: { LOCALAPPDATA: root }, platform: "win32", ...options }),
    write: async (parts, value) => {
      const target = path.join(root, ...parts);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, value);
    },
  };
}
const settings = (profile = {}, extras = {}) => JSON.stringify({ defaultProfile: "{ABCD}", profiles: { list: [{ guid: "{abcd}", name: "PowerShell 7", ...profile }] }, ...extras });

test("imports JSONC default profile with inherited font and overridden scheme colors", async (t) => {
  const f = await fixture(t);
  await f.write(stable, `\uFEFF{
    // Preserve comment markers inside strings.
    "defaultProfile": "{ABCD}",
    "profiles": { "defaults": { "font": { "face": "JetBrainsMono Nerd Font", "size": 12 }, "colorScheme": "Catppuccin" },
      "list": [{ "guid": "{abcd}", "name": "PowerShell 7", "font": { "size": 15 }, "foreground": "#abcdef", "commandline": "https://ignored/*test*/,}", },], },
    /* Palette */ "schemes": [{ "name": "Catppuccin", "background": "#303446", "foreground": "#ffffff", "purple": "#ca9ee6", "brightPurple": "#ffffff", "cursorColor": "#eeeeee", }],
  }`);
  assert.deepEqual(await f.read(), { profileName: "PowerShell 7", fontFamily: "JetBrainsMono Nerd Font", fontSize: 20, theme: { background: "#303446", foreground: "#abcdef", magenta: "#ca9ee6", brightMagenta: "#ffffff", cursor: "#eeeeee" } });
});

test("selects dark or light schemes and skips unknown built-in colors", async (t) => {
  const f = await fixture(t);
  await f.write(stable, settings({ colorScheme: { dark: "Night", light: "Day" } }, { schemes: [{ name: "Night", red: "#ff0000" }, { name: "Day", red: "#880000" }] }));
  assert.equal((await f.read()).theme.red, "#ff0000");
  assert.equal((await f.read({ dark: false })).theme.red, "#880000");
  await f.write(stable, settings({ colorScheme: "Unprovided built-in" }));
  assert.deepEqual((await f.read()).theme, {});
});

test("falls back through preview and unpackaged settings without executing commands", async (t) => {
  const f = await fixture(t);
  await f.write(stable, "{ /* unfinished");
  await f.write(preview, settings({ name: "Preview", fontFace: "Cascadia Code", fontSize: 9, commandline: "must never execute" }));
  await f.write(unpackaged, settings({ name: "Unpackaged" }));
  assert.deepEqual(await f.read(), { profileName: "Preview", fontFamily: "Cascadia Code", fontSize: 12, theme: {} });
  await f.write(preview, "null");
  assert.equal((await f.read()).profileName, "Unpackaged");
});

test("rejects invalid fields, missing default and oversized files", async (t) => {
  const f = await fixture(t);
  await f.write(stable, settings({ font: { face: "bad\u001bfont", size: 1000 }, background: "url(file:///secret)", foreground: "#12345g" }));
  assert.deepEqual(await f.read(), { profileName: "PowerShell 7", theme: {} });
  await f.write(stable, settings({}, { defaultProfile: "missing" }));
  assert.equal(await f.read(), null);
  await f.write(stable, " ".repeat(1024 * 1024 + 1));
  assert.equal(await f.read(), null);
  assert.equal(await f.read({ platform: "linux" }), null);
  assert.equal(await f.read({ env: {} }), null);
});
