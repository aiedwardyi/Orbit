// Joins a phone socket to a parked data channel (design section 3).
// `go` and the buffered ClientHello leave in one write; after that both
// directions are plain stream pipes with per-socket backpressure, no framing,
// no decryption and no application buffering.

import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { encodeFrame } from "../../shared/relay-protocol.ts";

export interface SpliceOptions {
  phone: Socket;
  data: TLSSocket;
  /** Every byte read from the phone so far, ClientHello first. */
  buffered: Buffer;
  /** Phone IP for `go {peer}`. */
  peer: string;
  idleMs: number;
  onEnd: (stats: { bytesIn: number; bytesOut: number; durationMs: number }) => void;
  now?: () => number;
}

export interface SplicedPair {
  destroy(): void;
}

export function splice(opts: SpliceOptions): SplicedPair {
  const { phone, data } = opts;
  const now = opts.now ?? Date.now;
  const started = now();
  phone.setNoDelay(true);
  data.setNoDelay(true);
  phone.allowHalfOpen = true;
  data.allowHalfOpen = true;

  let done = false;
  const destroy = () => {
    if (done) return;
    done = true;
    phone.destroy();
    data.destroy();
    opts.onEnd({ bytesIn: phone.bytesRead, bytesOut: phone.bytesWritten, durationMs: now() - started });
  };

  data.write(Buffer.concat([encodeFrame({ type: "go", peer: opts.peer }), opts.buffered]));
  // pipe() pauses the source while the destination's buffer is full, per
  // direction and per pair; an end propagates as a half close.
  phone.pipe(data);
  data.pipe(phone);
  for (const socket of [phone, data]) {
    socket.on("error", destroy);
    socket.once("close", destroy);
    socket.setTimeout(opts.idleMs, destroy);
  }
  return { destroy };
}
