import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

async function rig(onBattery = false) {
  const { createKeepAwakeController } = await import("./keep-awake.mjs");
  const blocker = { start: vi.fn(() => 0), isStarted: vi.fn(() => true), stop: vi.fn() };
  const keepAwake = createKeepAwakeController(blocker);
  const server = new EventEmitter();
  keepAwake.setOnBattery(onBattery);
  keepAwake.setPhoneServer(server);
  const phone = (on) => server.emit("message", { type: "wink:phone-keep-awake", on });
  return { blocker, keepAwake, server, phone };
}

describe("phone and companion keep-awake", () => {
  it("starts only after the server reports phone access ready on AC", async () => {
    const { blocker, phone } = await rig();
    expect(blocker.start).not.toHaveBeenCalled();
    phone(false);
    expect(blocker.start).not.toHaveBeenCalled();
    phone(true);
    phone(true);
    expect(blocker.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
  });

  it("releases when phone access is off or setup is gone", async () => {
    const { blocker, phone } = await rig();
    phone(true);
    phone(false);
    phone(false);
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
    phone(true);
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });

  it("releases on battery and restores on AC without another server report", async () => {
    const { blocker, keepAwake, phone } = await rig(true);
    phone(true);
    expect(blocker.start).not.toHaveBeenCalled();
    keepAwake.setOnBattery(false);
    expect(blocker.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
    keepAwake.setOnBattery(true);
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
    keepAwake.setOnBattery(false);
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });

  it("releases on server exit and waits for the restarted server to report", async () => {
    const { blocker, keepAwake, server, phone } = await rig();
    phone(true);
    server.emit("exit", 1);
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
    phone(true);
    expect(blocker.start).toHaveBeenCalledTimes(1);
    const restarted = new EventEmitter();
    keepAwake.setPhoneServer(restarted);
    expect(blocker.start).toHaveBeenCalledTimes(1);
    restarted.emit("message", { type: "wink:phone-keep-awake", on: true });
    expect(blocker.start).toHaveBeenCalledTimes(2);
    server.emit("message", { type: "wink:phone-keep-awake", on: false });
    server.emit("exit", 0);
    expect(blocker.stop).toHaveBeenCalledTimes(1);
  });

  it("clears a replaced server's hold until the new server reports", async () => {
    const { blocker, keepAwake, server, phone } = await rig();
    phone(true);
    const replacement = new EventEmitter();
    keepAwake.setPhoneServer(replacement);
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
    phone(true);
    server.emit("exit", 1);
    expect(blocker.start).toHaveBeenCalledTimes(1);
    replacement.emit("message", { type: "wink:phone-keep-awake", on: true });
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });

  it("keeps the phone hold when the companion hold is released", async () => {
    const { blocker, keepAwake, phone } = await rig();
    keepAwake.setCompanion(true, true);
    phone(true);
    expect(blocker.start).toHaveBeenCalledTimes(1);
    keepAwake.setCompanion(false, false);
    expect(blocker.stop).not.toHaveBeenCalled();
    phone(false);
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("keeps the companion hold through phone disable, battery, and server exit", async () => {
    const { blocker, keepAwake, server, phone } = await rig();
    phone(true);
    keepAwake.setCompanion(true, true);
    phone(false);
    keepAwake.setOnBattery(true);
    server.emit("exit", 1);
    expect(blocker.stop).not.toHaveBeenCalled();
    keepAwake.setCompanion(true, false);
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("preserves companion keep-awake on battery only while both settings hold", async () => {
    const { blocker, keepAwake } = await rig(true);
    keepAwake.setCompanion(false, true);
    keepAwake.setCompanion(true, false);
    expect(blocker.start).not.toHaveBeenCalled();
    keepAwake.setCompanion(true, true);
    expect(blocker.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
    keepAwake.setCompanion(false, true);
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("releases all reasons on quit and ignores late updates", async () => {
    const { blocker, keepAwake, phone } = await rig();
    phone(true);
    keepAwake.setCompanion(true, true);
    keepAwake.stop();
    keepAwake.stop();
    phone(true);
    keepAwake.setCompanion(true, true);
    keepAwake.setOnBattery(false);
    keepAwake.setPhoneServer(new EventEmitter());
    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("ignores unrelated and malformed server messages", async () => {
    const { blocker, server, phone } = await rig();
    for (const message of [null, {}, { type: "orbit:api-token", on: true }, { type: "wink:phone-keep-awake", on: "true" }]) {
      server.emit("message", message);
    }
    expect(blocker.start).not.toHaveBeenCalled();
    phone(true);
    server.emit("message", { type: "wink:phone-keep-awake" });
    expect(blocker.stop).not.toHaveBeenCalled();
  });
});
