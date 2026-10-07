// Process entry: node wink-relay.mjs --config /etc/wink-relay/config.json

import { parseArgs } from "node:util";
import { loadConfig, operatorKeyPath, readOperatorKey } from "./config.ts";
import { stdoutLogger } from "./log.ts";
import { createRelay } from "./relay.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: "string" } } });
  if (!values.config) throw new Error("usage: wink-relay --config <file>");
  const config = await loadConfig(values.config);
  const log = stdoutLogger();
  const relay = await createRelay({
    base: config.base,
    operatorPrivateKey: await readOperatorKey(operatorKeyPath(config)),
    dataDir: config.dataDir,
    revokedLabelsFile: config.revokedLabelsFile,
    acme: config.acme,
    limits: config.limits,
    log,
  });
  await relay.listen(config.listen.port, config.listen.host);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    relay.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", () => void relay.reloadRevocations());
}

main().catch((error: unknown) => {
  // Messages here are our own (config, key file, listen); never key material.
  process.stderr.write(`wink-relay: ${error instanceof Error ? error.message : "failed to start"}\n`);
  process.exit(1);
});
