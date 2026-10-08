import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";

import { isRelayRequest, markRelaySocket } from "./via.ts";

function requestOn(socket: Socket, headers: Record<string, string> = {}): IncomingMessage {
  const req = new IncomingMessage(socket);
  req.headers = headers;
  return req;
}

describe("relay request marking", () => {
  it("treats requests on a marked socket as relay traffic", () => {
    const socket = new Socket();
    markRelaySocket(socket);
    expect(isRelayRequest(requestOn(socket))).toBe(true);
    expect(isRelayRequest(requestOn(socket))).toBe(true);
  });

  it("does not treat an unmarked socket as relay traffic", () => {
    expect(isRelayRequest(requestOn(new Socket()))).toBe(false);
  });

  it("cannot be faked with a header", () => {
    const req = requestOn(new Socket(), { via: "wink-relay", "x-wink-relay": "1", "x-forwarded-for": "203.0.113.9" });
    expect(isRelayRequest(req)).toBe(false);
  });
});
