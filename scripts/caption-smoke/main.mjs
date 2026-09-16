import { app, BrowserWindow, nativeTheme } from "electron";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const worktree = join(here, "..", "..");
const outDir =
  process.env.OMB_CAPTION_SMOKE_OUT ||
  join("C:/Users/mredw/.codex/handoffs/orbit-refinement-assets/caption-smoke");

const { WINDOWS_CAPTION_HEIGHT, windowChromeOptions } = await import(
  pathToFileURL(join(worktree, "electron", "window-chrome.mjs")).href
);
const { skinChrome, skinThemeSource } = await import(
  pathToFileURL(join(worktree, "electron", "skin-overlay.cjs")).href
);

const SKINS = ["midnight", "ledger", "tui-amber"];
const SIZES = [
  { w: 1440, h: 920, tag: "1440x920" },
  { w: 900, h: 600, tag: "900x600" },
];

function pageHtml(skin, chrome) {
  const height = WINDOWS_CAPTION_HEIGHT;
  return `<!doctype html><html data-orbit-caption="win32" data-skin="${skin}"><head><style>
html,body{margin:0;height:100%;background:${chrome.color};color:${chrome.symbolColor};font:13px system-ui,sans-serif}
body{box-sizing:border-box;padding-top:${height}px}
.caption{position:fixed;top:0;left:0;right:0;height:${height}px;background:${chrome.color};-webkit-app-region:drag;border-bottom:1px solid rgba(127,127,127,.25)}
.row{display:flex;height:48px;align-items:center;padding:0 16px;gap:12px;background:${chrome.color}}
.btn{padding:6px 10px;border:1px solid ${chrome.symbolColor};border-radius:6px;-webkit-app-region:no-drag}
.mark{position:absolute;top:${height}px;right:8px;width:12px;height:12px;background:#22c55e;border-radius:2px}
.proof{padding:16px;line-height:1.5}
code{background:rgba(127,127,127,.15);padding:1px 4px;border-radius:4px}
</style></head><body>
<div class="caption" aria-hidden></div>
<div class="row"><span class="btn" id="probe">Header action</span><strong>${skin}</strong><span>caption ${height}px · skin chrome</span></div>
<div class="mark" id="below-controls" title="must stay below overlay"></div>
<div class="proof">
  <div>Inset proof: green mark sits at y=${height} (below caption).</div>
  <div>Native min/max/close overlay colors: <code>${chrome.color}</code> / <code>${chrome.symbolColor}</code></div>
  <div id="metrics"></div>
</div>
<script>
const m = document.getElementById('metrics');
const probe = document.getElementById('probe').getBoundingClientRect();
const mark = document.getElementById('below-controls').getBoundingClientRect();
m.textContent = 'probe.top=' + Math.round(probe.top) + ' mark.top=' + Math.round(mark.top) +
  ' titlebar-area-height=' + getComputedStyle(document.documentElement).getPropertyValue('env(titlebar-area-height)');
window.__captionSmoke = { probeTop: probe.top, markTop: mark.top, caption: ${height} };
</script>
</body></html>`;
}

async function shoot(skin, size) {
  const chrome = skinChrome(skin);
  nativeTheme.themeSource = skinThemeSource(skin);
  const win = new BrowserWindow({
    width: size.w,
    height: size.h,
    show: true,
    backgroundColor: chrome.color,
    autoHideMenuBar: true,
    ...windowChromeOptions(process.platform, chrome),
    webPreferences: { contextIsolation: true },
  });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(pageHtml(skin, chrome)));
  await new Promise((r) => setTimeout(r, 500));
  const metrics = await win.webContents.executeJavaScript("window.__captionSmoke");
  const png = await win.capturePage();
  const name = `caption-${skin}-${size.tag}.png`;
  writeFileSync(join(outDir, name), png.toPNG());
  win.close();
  return { name, metrics, chrome };
}

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const skin of SKINS) {
    for (const size of SIZES) {
      results.push(await shoot(skin, size));
    }
  }
  writeFileSync(join(outDir, "caption-smoke-report.json"), JSON.stringify({ platform: process.platform, results }, null, 2));
  const bad = results.filter((r) => !r.metrics || r.metrics.probeTop < WINDOWS_CAPTION_HEIGHT - 1);
  if (bad.length) {
    console.error("CAPTION_SMOKE_FAIL", bad);
    app.exit(2);
    return;
  }
  console.log("CAPTION_SMOKE_OK", results.map((r) => r.name).join(","));
  app.quit();
});
