import { afterEach, expect, it } from "vitest";
import { encodeFrame } from "../../shared/relay-protocol.ts";
import { FrameReader, closed, connectRelay, makePc, startRelay, type Harness } from "./fixtures.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

it("stops after the first rejected buffered auth frame", async () => {
  h = await startRelay({ limits: { controlAuthPerIpPerMin: 1 } });
  const pc = makePc();
  const socket = await connectRelay(h, "wink-ctl/1");
  const reader = new FrameReader(socket);
  expect((await reader.next())?.type).toBe("hello");
  const bad = encodeFrame({ type: "auth", label: pc.label, pk: pc.pk, ticket: `wkt1.e30.${"A".repeat(86)}`, sig: "x" });
  try {
    socket.write(Buffer.concat(Array.from({ length: 32 }, () => bad)));
    await closed(socket);
    const rejected = h.logs.map((line) => JSON.parse(line)).filter((entry) => entry.reason === "ticket-bad-signature");
    expect(rejected).toHaveLength(1);
  } finally {
    socket.destroy();
  }
});

it("closes rejected control sockets even when the peer trickles bytes", async () => {
  h = await startRelay({ limits: { authTimeoutMs: 100 } });
  const pc = makePc();
  const socket = await connectRelay(h, "wink-ctl/1");
  socket.allowHalfOpen = true;
  const reader = new FrameReader(socket);
  expect((await reader.next())?.type).toBe("hello");
  const ended = new Promise<void>((resolve) => socket.once("end", resolve));
  socket.write(encodeFrame({ type: "auth", label: pc.label, pk: pc.pk, ticket: `wkt1.e30.${"A".repeat(86)}`, sig: "x" }));
  await ended;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(16 * 1024);
  socket.write(header);
  const trickle = setInterval(() => {
    if (!socket.destroyed) socket.write("x");
  }, 100);
  let deadline: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      closed(socket).then(() => "closed"),
      new Promise<string>((resolve) => (deadline = setTimeout(() => resolve("still-open"), 3_000))),
    ]);
    expect(result).toBe("closed");
  } finally {
    clearInterval(trickle);
    clearTimeout(deadline);
    socket.destroy();
  }
});
