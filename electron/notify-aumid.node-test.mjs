import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEV_WINDOWS_APP_USER_MODEL_ID,
  WINDOWS_APP_USER_MODEL_ID,
  parseNotificationTargetFromCommandLine,
  windowsAppUserModelId,
} from "./desktop-notify.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

describe("notify AUMID isolation", () => {
  it("keeps the packaged AUMID on the installed appId", () => {
    assert.equal(WINDOWS_APP_USER_MODEL_ID, "com.orbit.agentdesk");
    assert.equal(windowsAppUserModelId(), "com.orbit.agentdesk");
    assert.equal(windowsAppUserModelId({ packaged: true }), "com.orbit.agentdesk");
  });

  it("uses a separate AUMID for unpackaged dev runs", () => {
    assert.equal(DEV_WINDOWS_APP_USER_MODEL_ID, "com.orbit.agentdesk.dev");
    assert.equal(windowsAppUserModelId({ packaged: false }), "com.orbit.agentdesk.dev");
    assert.notEqual(
      windowsAppUserModelId({ packaged: false }),
      windowsAppUserModelId({ packaged: true }),
    );
  });

  it("selects the AUMID from the packaged flag in main before any window", () => {
    const main = read("electron/main.mjs");
    assert.ok(main.includes("setAppUserModelId(windowsAppUserModelId("));
    assert.ok(main.includes("app.isPackaged"));
    const aumidAt = main.indexOf("setAppUserModelId(windowsAppUserModelId(");
    const readyAt = main.indexOf("app.whenReady()");
    assert.ok(aumidAt > -1 && readyAt > aumidAt);
  });
});

describe("notification activation args", () => {
  it("parses bot/thread flags from a second-instance command line", () => {
    assert.deepEqual(
      parseNotificationTargetFromCommandLine([
        "Orbit.exe",
        "--orbit-notify-bot=bot-7",
        "--orbit-notify-thread=thread-7",
      ]),
      { botId: "bot-7", threadId: "thread-7" },
    );
  });

  it("carries terminal attention through activation args", () => {
    assert.deepEqual(
      parseNotificationTargetFromCommandLine([
        "Orbit.exe",
        "--orbit-notify-bot=bot-1",
        "--orbit-notify-thread=thread-1",
        "--orbit-notify-open-terminal",
        "--orbit-notify-terminal-session=s-1",
      ]),
      { botId: "bot-1", threadId: "thread-1", openTerminal: true, terminalSessionId: "s-1" },
    );
  });

  it("returns null when activation args carry no bot/thread", () => {
    assert.equal(parseNotificationTargetFromCommandLine(["Orbit.exe", "-Embedding"]), null);
    assert.equal(parseNotificationTargetFromCommandLine(["Orbit.exe"]), null);
    assert.equal(parseNotificationTargetFromCommandLine([]), null);
  });

  it("routes second-instance activation args like a notification click", () => {
    const main = read("electron/main.mjs");
    const at = main.indexOf('app.on("second-instance"');
    assert.ok(at > -1);
    const block = main.slice(at, at + 2000);
    assert.ok(block.includes("parseNotificationTargetFromCommandLine"));
    assert.ok(block.includes("activateExistingWindow"));
    assert.ok(block.includes("deliverNotificationTarget"));
    assert.ok(main.includes('webContents.send("desktop:notification-click"'));
  });
});
