import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "App.tsx"), "utf8");

describe("first-chat boot keeps off-screen panels out of the initial module graph", () => {
  it("lazy-loads settings, computer, plugins, and other secondary surfaces", () => {
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/SettingsPanel"\)/);
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/SettingsModal"\)/);
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/ComputerPanel"\)/);
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/PluginsPanel"\)/);
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/InspectorPanel"\)/);
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/RoutinesPage"\)/);
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/CommandPalette"\)/);
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/TeamMapPage"\)/);
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/SkillRecorderPage"\)/);
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/LocalVmWorkspace"\)/);
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/BrowserWorkspace"\)/);
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/CreateBotSheet"\)/);
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/Onboarding"\)/);
    expect(app).toMatch(/lazy\(\(\) => import\("@\/components\/NoEngines"\)/);
    expect(app).not.toMatch(/^import \{ SettingsPanel/m);
    expect(app).not.toMatch(/^import \{ ComputerPanel/m);
    expect(app).not.toMatch(/^import \{ CommandPalette/m);
  });

  it("still mounts chat chrome eagerly and keeps Computer behind the friends gate", () => {
    expect(app).toMatch(/^import \{ Sidebar \} from "@\/components\/Sidebar";/m);
    expect(app).toMatch(/^import \{ ChatView \} from "@\/components\/ChatView";/m);
    expect(app).toContain("<ComputerPanel");
    expect(app).toContain("showComputerPanelChrome()");
    expect(app).toContain("<Suspense");
  });

  it("does not prefetch connected-apps on the first chat paint", () => {
    expect(app).toMatch(/preloadConnectedApps/);
    expect(app).toMatch(/requestIdleCallback/);
    expect(app).toMatch(/timeout:\s*800/);
    expect(app).toMatch(/import\("@\/components\/PluginsPanel"\)/);
  });

  it("isolates lazy overlays so one chunk cannot unmount the others", () => {
    expect(app).toMatch(/paletteReady && \([\s\S]*<Suspense fallback=\{null\}>/);
    expect(app).toMatch(/CreateBotSheet required=\{state\.bots\.length === 0\} \/>[\s\S]*?<\/Suspense>/);
    expect(app.match(/<Suspense fallback=\{null\}>/g)?.length).toBeGreaterThanOrEqual(6);
  });
});
