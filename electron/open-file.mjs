import fs from "node:fs";
import path from "node:path";

import { fileMenuTemplate } from "./context-menu.mjs";

// Types the OS default app may launch. Anything else (executables, scripts,
// shortcuts, html, no extension) is only revealed in its folder, never run.
export const OPENABLE_EXTENSIONS = new Set([
  "docx", "doc", "xlsx", "xls", "pptx", "ppt", "pdf", "txt", "md", "csv", "json", "rtf", "odt", "ods", "odp",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "mp3", "wav", "m4a", "mp4", "mov", "webm",
]);

const isInside = (root, target) => target === root || target.startsWith(root + path.sep);

// Explorer opens a folder named "x.{CLSID}" as that shell view (Control Panel and the like).
const SHELL_VIEW_NAME = /\.\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;

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
  const stat = await fsp.stat(filePath);
  if (stat.isDirectory()) return { filePath, directory: true, action: platform === "win32" && SHELL_VIEW_NAME.test(path.basename(filePath)) ? "reveal" : "folder" };
  if (!stat.isFile()) throw new Error("That path is not a file");
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return { filePath, directory: false, action: OPENABLE_EXTENSIONS.has(ext) ? "open" : "reveal" };
}

export async function openLocalFile(rawPath, { shell, ...options }) {
  const { filePath, action } = await resolveOpenTarget(rawPath, options);
  if (action === "reveal") {
    shell.showItemInFolder(filePath);
    return action;
  }
  // openPath resolves an error string rather than rejecting
  if (await shell.openPath(filePath)) throw new Error(action === "folder" ? "That folder could not be opened" : "That file could not be opened");
  return action;
}

// The save dialog confirms before overwriting. Picking the file itself copies nothing.
export async function saveFileCopy(filePath, { dialog, downloads, window, fsp = fs.promises }) {
  const { canceled, filePath: dest } = await dialog.showSaveDialog(window, { defaultPath: path.join(downloads, path.basename(filePath)) });
  if (canceled || !dest || path.resolve(dest) === filePath) return false;
  await fsp.copyFile(filePath, dest);
  return true;
}

// Resolves first, so a rejected path never gets a menu.
export async function fileMenuFor(rawPath, { text, shell, clipboard, dialog, downloads, window, onSaveError, ...options }) {
  const { filePath, directory } = await resolveOpenTarget(rawPath, options);
  return fileMenuTemplate({ directory }, text, {
    show: () => shell.showItemInFolder(filePath),
    save: () => saveFileCopy(filePath, { dialog, downloads, window, fsp: options.fsp }).catch(onSaveError),
    copyPath: () => clipboard.writeText(filePath),
  });
}
