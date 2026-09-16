/* oxlint-disable anti-slop/no-runtime-typeof -- Windows Terminal settings are untrusted external JSON. */
import fs from "node:fs/promises";
import path from "node:path";

const LIMIT = 1024 * 1024;
const COLORS = {
  background: "background", foreground: "foreground", cursorColor: "cursor", selectionBackground: "selectionBackground",
  black: "black", red: "red", green: "green", yellow: "yellow", blue: "blue", purple: "magenta", cyan: "cyan", white: "white",
  brightBlack: "brightBlack", brightRed: "brightRed", brightGreen: "brightGreen", brightYellow: "brightYellow", brightBlue: "brightBlue", brightPurple: "brightMagenta", brightCyan: "brightCyan", brightWhite: "brightWhite",
};
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const guid = (value) => typeof value === "string" ? value.replace(/[{}]/g, "").toLowerCase() : "";

function parseSettings(source) {
  let clean = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      clean += char;
      if (char === "\\") clean += source[++i] ?? "";
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      clean += char;
    } else if (char === "/" && source[i + 1] === "/") {
      while (i + 1 < source.length && source[i + 1] !== "\n") i++;
      clean += " ";
    } else if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unterminated comment");
      i = end + 1;
      clean += " ";
    } else clean += char;
  }
  let json = "";
  quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (quoted) {
      json += char;
      if (char === "\\") json += clean[++i] ?? "";
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      json += char;
    } else if (char === ",") {
      let next = i + 1;
      while (next < clean.length && /\s/.test(clean[next])) next++;
      if (clean[next] !== "}" && clean[next] !== "]") json += char;
    } else json += char;
  }
  return JSON.parse(json.replace(/^\uFEFF/, ""));
}

function appearance(settings, dark) {
  const profiles = object(settings.profiles);
  const list = Array.isArray(settings.profiles) ? settings.profiles : profiles.list;
  if (!Array.isArray(list) || !guid(settings.defaultProfile)) return null;
  const profile = list.find((entry) => guid(object(entry).guid) === guid(settings.defaultProfile));
  if (!profile || !text(profile.name)) return null;
  const defaults = object(profiles.defaults);
  const merged = { ...defaults, ...object(profile) };
  const font = { ...object(defaults.font), ...object(profile.font) };
  const schemeName = typeof merged.colorScheme === "string" ? merged.colorScheme : object(merged.colorScheme)[dark ? "dark" : "light"];
  const scheme = Array.isArray(settings.schemes) ? settings.schemes.find((entry) => object(entry).name === schemeName) : null;
  const theme = {};
  for (const [source, target] of Object.entries(COLORS)) {
    for (const candidate of [object(scheme)[source], merged[source]]) {
      if (typeof candidate === "string" && /^#[\da-f]{6}$/i.test(candidate)) theme[target] = candidate;
    }
  }
  const result = { profileName: profile.name, theme };
  const face = font.face ?? merged.fontFace;
  const size = font.size ?? merged.fontSize;
  if (text(face)) result.fontFamily = face;
  if (typeof size === "number" && Number.isFinite(size) && size >= 4 && size <= 96) result.fontSize = size * 4 / 3;
  return result;
}

export async function readTerminalAppearance({ env = process.env, platform = process.platform, dark = true } = {}) {
  if (platform !== "win32" || !env.LOCALAPPDATA) return null;
  const locations = [
    ["Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"],
    ["Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"],
    ["Microsoft", "Windows Terminal", "settings.json"],
  ];
  for (const parts of locations) {
    let file;
    try {
      file = await fs.open(path.join(env.LOCALAPPDATA, ...parts), "r");
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > LIMIT) continue;
      const buffer = Buffer.alloc(LIMIT + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > LIMIT) continue;
      const result = appearance(object(parseSettings(buffer.toString("utf8", 0, bytesRead))), dark);
      if (result) return result;
    } catch {} finally {
      await file?.close();
    }
  }
  return null;
}
