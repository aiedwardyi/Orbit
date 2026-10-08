import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PHONE_RELAY_OFF } from "../shared/relay-protocol.ts";
import * as atomic from "./atomic.ts";
import { PhoneAccess } from "./phone-access.ts";
import { phoneSetCookie } from "./phone-auth.ts";
import { PhoneDevices } from "./phone-devices.ts";
import { FakeClock } from "./phone-relay/testing/fake-clock.ts";
import { tempDataDir } from "./phone-relay/testing/harness.ts";
import { markRelaySocket } from "./phone-relay/via.ts";

const HOST = "abcdefghijklmnop.wink.test";
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function request(path: string, method = "GET") {
  const socket = new Socket();
  cleanups.push(() => { socket.destroy(); });
  const req = new IncomingMessage(socket);
  req.url = path;
  req.method = method;
  req.headers = { host: HOST };
  req.rawHeaders = ["host", HOST];
  return { req, res: new ServerResponse(req), socket };
}

describe("relay audit: phone revocation", () => {
  it("cuts the phone and allows retry after a transient revocation write failure", async () => {
    const { dir, cleanup } = tempDataDir();
    cleanups.push(cleanup);
    const clock = new FakeClock();
    const phones = new PhoneDevices(dir, clock);
    const paired = phones.redeem(phones.openPairing().token, "Lost phone", undefined);
    if (!paired.ok) throw new Error(paired.error);
    const access = new PhoneAccess({
      dataDir: dir,
      env: {},
      staticDir: null,
      config: () => ({ base: "wink.test", enabled: true }),
      saveEnabled: () => {},
      clock,
      start: () => ({
        status: () => ({ ...PHONE_RELAY_OFF, state: "connected", host: HOST }),
        stop: async () => {},
      }),
    });
    cleanups.push(() => access.stop());
    await access.start(() => {});
    const phone = request("/api/events");
    phone.req.headers.cookie = phoneSetCookie(paired.token).split(";")[0];
    markRelaySocket(phone.socket);
    expect(await access.gate(phone.req, phone.res)).toMatchObject({ handled: false, phone: { id: paired.phone.id } });

    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(() => {
      throw Object.assign(new Error("phone registry is busy"), { code: "EBUSY" });
    });
    const path = `/api/phone/devices/${paired.phone.id}`;
    const first = request(path, "DELETE");
    await expect(access.handle(first.req, first.res, path, "DELETE", true)).rejects.toThrow("phone registry is busy");
    expect.soft(phone.socket.destroyed).toBe(true);

    const retry = request(path, "DELETE");
    expect(await access.handle(retry.req, retry.res, path, "DELETE", true)).toBe(true);
    expect.soft(retry.res.statusCode).toBe(200);
    expect.soft(new PhoneDevices(dir, clock).authenticate(paired.token)).toBeNull();
  });
});
