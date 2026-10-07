import { afterEach, expect, it } from "vitest";
import { closed, connectRelay, startRelay, type Harness } from "./fixtures.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

it("holds API connection slots beyond request deadlines and rejects new clients", { timeout: 55_000 }, async () => {
  h = await startRelay({ limits: { maxConnections: 3 } });
  const sockets = await Promise.all(Array.from({ length: 3 }, () => connectRelay(h!, "http/1.1")));
  sockets.forEach((socket) => socket.resume());
  sockets[1].write("GET /v1/healthz HTTP/1.1\r\nHost: relay.");
  sockets[2].write(
    `POST /v1/enroll HTTP/1.1\r\nHost: relay.${h.base}\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{`,
  );
  let deadline: NodeJS.Timeout | undefined;
  try {
    // Exceeds requestTimeout plus Node's default 30-second checking interval.
    const result = await Promise.race([
      Promise.all(sockets.map(closed)).then(() => "closed"),
      new Promise<string>((resolve) => (deadline = setTimeout(() => resolve("still-open"), 45_000))),
    ]);
    expect(result).toBe("still-open");
    expect(sockets.map((socket) => socket.destroyed)).toEqual([false, false, false]);
    const next = await connectRelay(h, "http/1.1").catch(() => null);
    next?.destroy();
    expect(next).toBeNull();
  } finally {
    clearTimeout(deadline);
    sockets.forEach((socket) => socket.destroy());
  }
});
