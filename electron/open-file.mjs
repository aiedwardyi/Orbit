import fs from "node:fs";
import path from "node:path";

// Types the OS default app may launch. Anything else (executables, scripts,
// shortcuts, html, no extension) is only revealed in its folder, never run.
export const OPENABLE_EXTENSIONS = new Set([
  "docx", "doc", "xlsx", "xls", "pptx", "ppt", "pdf", "txt", "md", "csv", "json", "rtf", "odt", "ods", "odp",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "mp3", "wav", "m4a", "mp4", "mov", "webm",
]);

const isInside = (root, target) => target === root || target.startsWith(root + path.sep);

// Paths come from model-rendered markdown, so they are untrusted. The policy
// reads the real path, so a .pdf symlink to an .exe is revealed, not run. A
// UNC path would authenticate to a remote host before anything is checked, and
// a colon past the drive names an alternate data stream.
export async function resolveOpenTarget(rawPath, { base, fsp = fs.promises, platform = process.platform } = {}) {
  if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) throw new Error("That file path is invalid");
  if (platform === "win32" && (/^[\\/]{2}/.test(rawPath) || rawPath.slice(2).includes(":"))) throw new Error("That file path is invalid");
  let filePath;
  try {
    filePath = await fsp.realpath(rawPath);
  } catch {
    throw new Error("That file no longer exists");
  }
  if (base) {
    const root = await fsp.realpath(base).catch(() => null);
    if (!root || !isInside(root, filePath)) throw new Error("That file is outside the bot's folder");
  }
  if (!(await fsp.stat(filePath)).isFile()) throw new Error("That path is not a file");
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return { filePath, action: OPENABLE_EXTENSIONS.has(ext) ? "open" : "reveal" };
}

export async function openLocalFile(rawPath, { shell, ...options }) {
  const { filePath, action } = await resolveOpenTarget(rawPath, options);
  if (action === "reveal") {
    shell.showItemInFolder(filePath);
    return action;
  }
  // openPath resolves an error string rather than rejecting
  if (await shell.openPath(filePath)) throw new Error("That file could not be opened");
  return action;
}
