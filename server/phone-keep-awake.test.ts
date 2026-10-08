import { readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { PHONE_RELAY_OFF, type PhoneRelayStatus } from "../shared/relay-protocol.ts";
import { PhoneAccess } from "./phone-access.ts";
import type { PhoneRelayConfig, PhoneRelayOptions } from "./phone-relay/index.ts";

const HOST = "abcdefghijklmnop.wink.test";

function rig(onChange: (access: PhoneAccess) => void = () => {}) {
  const config: PhoneRelayConfig = { base: "wink.test", enabled: true };
  const env: NodeJS.ProcessEnv = {};
  let status: PhoneRelayStatus = { ...PHONE_RELAY_OFF, state: "connected", host: HOST };
  let notify = () => {};
  const stop = vi.fn(async () => {});
  const start = (options: PhoneRelayOptions) => {
    notify = () => options.onStatus({ ...status });
    return { status: () => ({ ...status }), stop };
  };
  const access: PhoneAccess = new PhoneAccess({
    dataDir: "unused",
    env,
    staticDir: null,
    config: () => config,
    saveEnabled: (enabled) => { config.enabled = enabled; },
    loadClient: async () => ({ start, enroll: async () => {}, peer: () => null }),
    onChange: () => onChange(access),
  });
  const change = (patch: Partial<PhoneRelayStatus>) => {
    status = { ...status, ...patch };
    notify();
  };
  return { access, config, env, change, stop };
}

describe("phone keep-awake reporting", () => {
  it("requires phone access on and a setup ticket, including while reconnecting", async () => {
    const { access, config, env, change } = rig();
    expect(access.keepAwake()).toBe(false);
    await access.start(() => {});
    expect(access.keepAwake()).toBe(true);
    for (const state of ["certifying", "reconnecting", "cert-error"] as const) {
      change({ state });
      expect(access.keepAwake()).toBe(true);
    }
    config.enabled = false;
    expect(access.keepAwake()).toBe(false);
    config.enabled = true;
    config.base = "";
    expect(access.keepAwake()).toBe(false);
    config.base = "wink.test";
    env.ORBIT_RELAY = "0";
    expect(access.keepAwake()).toBe(false);
    delete env.ORBIT_RELAY;
    change({ state: "enrolling" });
    expect(access.keepAwake()).toBe(false);
    change({ state: "rejected", lastError: "revoked" });
    expect(access.keepAwake()).toBe(false);
    change({ state: "connected", host: null });
    expect(access.keepAwake()).toBe(false);
    await access.stop();
  });

  it("posts the boot state and every setup or relay state change", async () => {
    const { postPhoneKeepAwake } = await import("./phone-keep-awake.ts");
    const port = { postMessage: vi.fn() };
    const { access, change } = rig((current) => postPhoneKeepAwake(current, port));
    postPhoneKeepAwake(access, port);
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "wink:phone-keep-awake", on: false });
    await access.start(() => {});
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "wink:phone-keep-awake", on: true });
    change({ state: "reconnecting" });
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "wink:phone-keep-awake", on: true });
    change({ state: "enrolling" });
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "wink:phone-keep-awake", on: false });
    change({ state: "rejected", lastError: "revoked" });
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "wink:phone-keep-awake", on: false });
    change({ state: "connected" });
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "wink:phone-keep-awake", on: true });
    await access.stop();
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "wink:phone-keep-awake", on: false });
  });

  it("posts off immediately when disabled, before relay shutdown finishes", async () => {
    const states: boolean[] = [];
    const { access, stop } = rig((current) => states.push(current.keepAwake()));
    await access.start(() => {});
    const req = new IncomingMessage(new Socket());
    req.push(Buffer.from('{"enabled":false}'));
    req.push(null);
    const res = new ServerResponse(req);
    const writeHead = vi.spyOn(res, "writeHead");
    stop.mockImplementation(async () => {
      expect(states.at(-1)).toBe(false);
    });
    await access.handle(req, res, "/api/phone-relay", "PUT", true);
    expect(states.at(-1)).toBe(false);
    expect(writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    await access.stop();
  });

  it("is a no-op without a utility parent port", async () => {
    const { postPhoneKeepAwake } = await import("./phone-keep-awake.ts");
    const access = { keepAwake: vi.fn(() => true) };
    expect(() => postPhoneKeepAwake(access)).not.toThrow();
    expect(access.keepAwake).not.toHaveBeenCalled();
  });

  it("wires boot reporting and change reporting before the presence short-circuit", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const setup = source.slice(source.indexOf("const phoneAccess: PhoneAccess"), source.indexOf("function authorizedComms"));
    expect(setup).toMatch(/onChange: \(\) => \{\s*postPhoneKeepAwake\(phoneAccess, utilityParentPort\)/);
    expect(setup).toMatch(/\}\);\s*postPhoneKeepAwake\(phoneAccess, utilityParentPort\);/);
  });
});
