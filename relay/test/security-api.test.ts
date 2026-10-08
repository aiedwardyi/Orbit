import { afterEach, expect, it } from "vitest";
import { closed, connectRelay, startRelay, type Harness } from "./fixtures.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

it("releases idle and trickling API connections after deadlines and accepts new clients", async () => {
  h = await startRelay({ limits: { maxConnections: 3 } });
  const sockets = await Promise.all(Array.from({ length: 3 }, () => connectRelay(h!, "http/1.1")));
  sockets.forEach((socket) => socket.resume());
  sockets[1].write("GET /v1/healthz HTTP/1.1\r\nHost: relay.");
  sockets[2].write(
    `POST /v1/enroll HTTP/1.1\r\nHost: relay.${h.base}\r\nContent-Type: application/json\r\nContent-Length: 1024\r\n\r\n{`,
  );
  const trickle = setInterval(() => {
    for (const socket of sockets.slice(1)) if (!socket.destroyed) socket.write(" ");
  }, 250);
  let deadline: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      Promise.all(sockets.map(closed)).then(() => "closed"),
      new Promise<string>((resolve) => (deadline = setTimeout(() => resolve("still-open"), 13_000))),
    ]);
    expect(result).toBe("closed");
    expect(sockets.map((socket) => socket.destroyed)).toEqual([true, true, true]);
    const next = await connectRelay(h, "http/1.1").catch(() => null);
    next?.destroy();
    expect(next).not.toBeNull();
  } finally {
    clearInterval(trickle);
    clearTimeout(deadline);
    sockets.forEach((socket) => socket.destroy());
  }
});
