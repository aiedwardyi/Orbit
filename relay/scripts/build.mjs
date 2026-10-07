// Bundles the relay and the invite script into self-contained ESM files in dist/.
// shared/ lives outside this package, so its imports resolve through this
// package's node_modules.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: { "wink-relay": "src/main.ts", "mint-invite": "scripts/mint-invite.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  nodePaths: [`${root}node_modules`],
  // acme-client and its deps are CommonJS and call require() on builtins.
  banner: { js: "import { createRequire as __wrCreateRequire } from 'node:module'; const require = __wrCreateRequire(import.meta.url);" },
  legalComments: "linked",
  logLevel: "warning",
});
