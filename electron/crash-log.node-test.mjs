import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { crashLogLine, formatCrashError, installMainCrashLogging } from "./crash-log.mjs";

test("formats crash lines for the four Electron death signals", () => {
  assert.equal(crashLogLine("uncaughtException", "boom"), "crash uncaughtException: boom");
  assert.equal(crashLogLine("unhandledRejection", "nope"), "crash unhandledRejection: nope");
  assert.equal(crashLogLine("render-process-gone", "reason=crashed"), "crash render-process-gone: reason=crashed");
  assert.equal(crashLogLine("child-process-gone", "type=Utility"), "crash child-process-gone: type=Utility");
});

test("installMainCrashLogging writes each death signal to the log", () => {
  const lines = [];
  const proc = new EventEmitter();
  const electronApp = new EventEmitter();
  installMainCrashLogging({ process: proc, app: electronApp, log: (line) => lines.push(line) });
  proc.emit("uncaughtException", new Error("main exploded"));
  proc.emit("unhandledRejection", "lost promise");
  electronApp.emit("render-process-gone", {}, { getURL: () => "http://127.0.0.1:8799/" }, { reason: "crashed", exitCode: 1 });
  electronApp.emit("child-process-gone", {}, { type: "Utility", reason: "killed", exitCode: 9, name: "orbit-server" });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^crash uncaughtException: Error: main exploded/);
  assert.match(lines[1], /^crash unhandledRejection: lost promise/);
  assert.match(lines[2], /^crash render-process-gone: reason=crashed exitCode=1/);
  assert.match(lines[3], /^crash child-process-gone: type=Utility reason=killed exitCode=9/);
});

test("formatCrashError keeps the stack for Error values", () => {
  const error = new Error("boom");
  const text = formatCrashError(error);
  assert.match(text, /^Error: boom/);
  assert.match(text, /crash-log\.node-test/);
});
