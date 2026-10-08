import type { AddressInfo, Server } from "node:net";

/** Listens on an ephemeral loopback port (test servers only) and returns it. */
export async function listenLocal(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: a TCP server listening on a host and port reports AddressInfo.
  return (server.address() as AddressInfo).port;
}
