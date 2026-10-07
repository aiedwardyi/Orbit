import { createHash, randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterEach, expect, it } from "vitest";
import { captureClientHello, event, makePc, openControl, openData, rawConnect, startRelay, type Harness } from "./fixtures.ts";
import { awaitGo } from "./pc-side.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Resolves with exactly `n` bytes read from `socket` after `prefix`. */
function readExactly(socket: Socket, n: number, prefix: Buffer = Buffer.alloc(0)): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks = [prefix];
    let size = prefix.length;
    const finish = (error?: Error) => {
      socket.off("data", onData);
      socket.off("error", finish);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).subarray(0, n));
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= n) finish();
    };
    if (size >= n) {
      resolve(prefix.subarray(0, n));
      return;
    }
    socket.on("data", onData);
    socket.on("error", finish);
  });
}

async function splicePair(h: Harness, session: string, token: string, hello: Buffer) {
  const data = await openData(h, session, token);
  await h.waitLog(event("join", { reason: "parked" }), (pairs += 1));
  const phone = await rawConnect(h);
  const go = awaitGo(data);
  phone.write(hello);
  const { rest } = await go;
  // The PC end first consumes the ClientHello the relay forwarded.
  const helloAtPc = await readExactly(data.resume() as TLSSocket, hello.length, rest);
  expect(helloAtPc.equals(hello)).toBe(true);
  return { data, phone };
}
let pairs = 0;

it("a paused reader on one splice does not delay another, and bytes arrive exactly", async () => {
  pairs = 0;
  h = await startRelay();
  const pc = makePc();
  const ctl = await openControl(h, pc);
  const hello = await captureClientHello(`${pc.label}.${h.base}`);
  const slow = await splicePair(h, ctl.ready.session, ctl.ready.poolToken, hello);
  const fast = await splicePair(h, ctl.ready.session, ctl.ready.poolToken, hello);

  // The slow PC stops reading; its phone pushes far more than socket buffers hold.
  slow.data.pause();
  const bulk = randomBytes(32 * 1024 * 1024);
  const drained = !slow.phone.write(bulk);
  expect(drained).toBe(true);

  // Meanwhile SSE-sized frames on the other pair arrive one by one, promptly.
  const latencies: number[] = [];
  for (let i = 0; i < 50; i++) {
    const frame = Buffer.from(`id: ${i}\nevent: message\ndata: {"seq":${i},"text":"${"x".repeat(80)}"}\n\n`);
    const started = performance.now();
    const got = readExactly(fast.phone, frame.length);
    fast.data.write(frame);
    expect((await got).equals(frame)).toBe(true);
    latencies.push(performance.now() - started);
    const up = Buffer.from(`ack ${i}`);
    const back = readExactly(fast.data, up.length);
    fast.phone.write(up);
    expect((await back).equals(up)).toBe(true);
  }
  latencies.sort((a, b) => a - b);
  expect(latencies[25]).toBeLessThan(50);
  expect(latencies[49]).toBeLessThan(1_000);

  // Backpressure reached the slow phone itself: the relay did not absorb its upload.
  expect(slow.phone.writableLength).toBeGreaterThan(0);

  // Once the slow PC reads again, every byte arrives in order.
  const received = readExactly(slow.data, bulk.length);
  slow.data.resume();
  const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  expect(digest(await received)).toBe(digest(bulk));

  slow.phone.destroy();
  fast.phone.destroy();
  ctl.socket.destroy();
});
