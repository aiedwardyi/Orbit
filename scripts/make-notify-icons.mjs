// Pre-renders every painted mascot (style x palette color) to the PNG a
// notification shows as the sending bot's icon.
//
//   pnpm exec electron scripts/make-notify-icons.mjs
//
// Phones and Windows toasts cannot draw the app's inline SVG mascots, so each
// one ships as public/notify-icons/<style>-<color>.png, 192 px on a
// transparent background. The SVG comes from mascotSvgMarkup in
// src/lib/mascot-art.ts (loaded through Vite for its ?raw imports), so the
// PNGs match the UI. Chromium's PNGs are re-encoded by png-codec.mjs, about
// a third smaller. Re-run after changing mascot art or the palette;
// scripts/notify-icons.test.mjs fails when a style or color has no PNG.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { runnerImport } from "vite";
import { decodePng, encodePng } from "./png-codec.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "notify-icons");
const SIZE = 192;

const userData = mkdtempSync(join(tmpdir(), "notify-icons-"));
app.setPath("userData", userData);

async function rasterize(svg, size) {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  canvas.getContext("2d").drawImage(image, 0, 0, size, size);
  return canvas.toDataURL("image/png");
}

// No top-level await: Electron holds `ready` until an ESM main finishes loading.
async function main() {
  const inline = { configFile: false, root: ROOT, logLevel: "silent", resolve: { alias: { "@": join(ROOT, "src") } } };
  const { module: art } = await runnerImport("/src/lib/mascot-art.ts", inline);
  const { module: avatar } = await runnerImport("/shared/bot-avatar.ts", inline);
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL("about:blank");
  mkdirSync(OUT_DIR, { recursive: true });
  let bytes = 0;
  let count = 0;
  for (const style of avatar.MASCOT_STYLES) {
    for (const color of avatar.NOTIFY_ICON_COLORS) {
      const svg = art.mascotSvgMarkup(style, color);
      const url = await win.webContents.executeJavaScript(`(${rasterize})(${JSON.stringify(svg)}, ${SIZE})`);
      const path = join(ROOT, "public", avatar.mascotNotifyIconPath(style, color));
      writeFileSync(path, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
      const png = encodePng(decodePng(path));
      writeFileSync(path, png);
      bytes += png.length;
      count += 1;
    }
  }
  win.destroy();
  console.log(`Wrote ${count} PNGs to public/notify-icons (${(bytes / 1024).toFixed(1)} KB).`);
}

app
  .whenReady()
  .then(main)
  .catch((cause) => {
    console.error(cause);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      // Chromium may still hold the profile; it is only a temp folder.
    }
    app.exit(process.exitCode ?? 0);
  });
