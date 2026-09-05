// The packaged boot moves plaintext secrets out of config.json and into
// credentials.bin. Both halves have to happen, in that order: v1.0.1 shipped a
// launch that rewrote config.json without ever writing the encrypted copy,
// which destroyed the user's xAI key and the Composio installation identity
// with no error and no way back. These drive the real main.mjs functions in
// the order app.whenReady() calls them, against a fake safeStorage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const XAI_SECRET = "xai-plaintext-secret";
const COMPOSIO_SECRET = "ak_plaintext_installation_identity";

const h = vi.hoisted(() => ({ home: "", encryptionAvailable: true, writes: [] }));

// speech.mjs resolves its packaged helper bundle from this at import time.
process.resourcesPath ??= path.join(os.tmpdir(), "orbit-boot-credentials-resources");

vi.mock("electron", () => {
  const auto = () =>
    new Proxy(function () {}, {
      get: (_t, key) => (key === "then" ? undefined : auto()),
      apply: () => auto(),
      construct: () => auto(),
    });
  const app = {
    isPackaged: true,
    // slog() swallows its own failures, and an ENOTDIR log path keeps it from
    // holding a write stream open in a temp dir each test then deletes.
    getPath: (name) => (name === "logs" ? path.join(configPath(), "logs") : path.join(h.home, name)),
    getVersion: () => "1.0.2",
    getName: () => "Orbit",
    getAppPath: () => h.home,
    getLocale: () => "en-US",
    on: () => {},
    once: () => {},
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: () => true,
    commandLine: { appendSwitch: () => {} },
    setAppUserModelId: () => {},
    setName: () => {},
    quit: () => {},
  };
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => h.encryptionAvailable,
    // Reversible stand-in for the OS keychain. The snapshot is the point of
    // the whole file: config.json must still hold the plaintext at the moment
    // the encrypted copy is written.
    encryptStringAsync: async (plain) => {
      h.writes.push({ document: JSON.parse(plain), config: fs.readFileSync(configPath(), "utf8") });
      return Buffer.from(plain, "utf8");
    },
    decryptStringAsync: async (buffer) => Buffer.from(buffer).toString("utf8"),
  };
  const BrowserWindow = Object.assign(function () {}, {
    getAllWindows: () => [],
    fromWebContents: () => null,
  });
  const stub = { app, safeStorage, BrowserWindow };
  for (const name of [
    "Notification", "WebContentsView", "clipboard", "desktopCapturer", "dialog", "ipcMain",
    "Menu", "nativeImage", "nativeTheme", "powerSaveBlocker", "screen", "session", "shell",
    "systemPreferences", "utilityProcess",
  ]) {
    stub[name] = auto();
  }
  stub.default = stub;
  return stub;
});

const configPath = () => path.join(h.home, "data", "config.json");
const credentialsPath = () => path.join(h.home, "userData", "credentials.bin");
const readConfig = () => JSON.parse(fs.readFileSync(configPath(), "utf8"));
const readCredentials = () => JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));

/** main.mjs as app.whenReady() reaches it: read credentials.bin, open the
 * document, then run both migrations after the window is revealed. */
async function bootPackagedCredentials(stored = {}) {
  vi.resetModules();
  const main = await import("./main.mjs");
  // The migrations mutate the live document in place; snapshot what the child
  // env fork would have seen before they run.
  const document = structuredClone(main.openSecureCredentialDocument(stored));
  await main.secureComposioConfig();
  await main.secureWorkspaceConfig();
  return { main, document };
}

describe("packaged boot credential migration", () => {
  let previousDataDir;

  beforeEach(() => {
    h.home = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-boot-credentials-"));
    h.encryptionAvailable = true;
    h.writes = [];
    fs.mkdirSync(path.join(h.home, "data"), { recursive: true });
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ xai: { key: XAI_SECRET }, composio: { apiKey: COMPOSIO_SECRET } }, null, 2),
    );
    previousDataDir = process.env.OMB_DATA_DIR;
    process.env.OMB_DATA_DIR = path.join(h.home, "data");
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.OMB_DATA_DIR;
    else process.env.OMB_DATA_DIR = previousDataDir;
    fs.rmSync(h.home, { recursive: true, force: true });
  });

  it("encrypts the xai and composio keys before config.json loses them", async () => {
    const { document } = await bootPackagedCredentials();

    expect(readCredentials()).toMatchObject({
      xaiApiKey: XAI_SECRET,
      composioApiKey: COMPOSIO_SECRET,
    });
    const config = readConfig();
    expect(config.xai).not.toHaveProperty("key");
    expect(config.composio.apiKey).toBe("");

    // The plaintext belongs to the child env, never to the document the
    // migrations compare config.json against — absorbing it there is what made
    // both writes look unnecessary.
    expect(document).not.toHaveProperty("xaiApiKey");
    expect(document).not.toHaveProperty("composioApiKey");

    // Each secret was still readable in config.json at the moment its
    // encrypted copy was written, so no launch can lose the only copy.
    expect(h.writes.find((w) => w.document.xaiApiKey === XAI_SECRET)?.config).toContain(XAI_SECRET);
    expect(h.writes.find((w) => w.document.composioApiKey === COMPOSIO_SECRET)?.config).toContain(
      COMPOSIO_SECRET,
    );
  });

  it("leaves the plaintext for the next launch when the store cannot be written", async () => {
    h.encryptionAvailable = false;

    await bootPackagedCredentials();

    expect(fs.existsSync(credentialsPath())).toBe(false);
    expect(readConfig()).toEqual({ xai: { key: XAI_SECRET }, composio: { apiKey: COMPOSIO_SECRET } });
  });

  it("does not rewrite a stored secret that config.json no longer carries", async () => {
    fs.writeFileSync(configPath(), JSON.stringify({ xai: {}, composio: { apiKey: "" } }, null, 2));

    const { document } = await bootPackagedCredentials({ xaiApiKey: XAI_SECRET });

    expect(document).toEqual({ xaiApiKey: XAI_SECRET });
    expect(fs.existsSync(credentialsPath())).toBe(false);
  });
});
