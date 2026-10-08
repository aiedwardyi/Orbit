// The PC end of a data channel after `go`: unwrap and serve the phone's TLS
// with the PC's own certificate, as Card B's ingress will.

import { createServer, connect as tlsConnect, type TLSSocket } from "node:tls";
import type { GoMessage } from "../../shared/relay-protocol.ts";
import { FrameReader, type Harness } from "./fixtures.ts";

export interface Accepted {
  go: GoMessage;
  /** Raw bytes that came behind `go` in the same read, ClientHello first. */
  rest: Buffer;
  /** The first chunk the data channel delivered after joining. */
  firstChunk: Buffer;
}

/** Waits for `go` and returns what came with it, leaving the socket paused. */
export function awaitGo(data: TLSSocket): Promise<Accepted> {
  return new Promise((resolve, reject) => {
    let firstChunk: Buffer | undefined;
    data.once("data", (chunk: Buffer) => {
      firstChunk = chunk;
    });
    const reader = new FrameReader(data);
    reader.next().then((msg) => {
      if (msg?.type !== "go") {
        reject(new Error(`expected go, got ${msg?.type ?? "close"}`));
        return;
      }
      data.pause();
      resolve({ go: msg, rest: reader.detach(), firstChunk: firstChunk! });
    }, reject);
  });
}

/** Terminates the phone's TLS inside the data channel. */
export async function serveInner(data: TLSSocket, cert: { key: string; cert: string }): Promise<TLSSocket> {
  const { rest } = await awaitGo(data);
  data.unshift(rest);
  const server = createServer({ ...cert, ALPNProtocols: ["http/1.1"] });
  return new Promise((resolve, reject) => {
    server.once("secureConnection", resolve);
    server.once("tlsClientError", reject);
    server.emit("connection", data);
  });
}

/** A phone: real TLS to <label>.<base> through the relay. */
export function phoneConnect(h: Harness, label: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: "127.0.0.1",
      port: h.port,
      servername: `${label}.${h.base}`,
      ca: h.ca.certPem,
      ALPNProtocols: ["http/1.1"],
    });
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
  });
}
