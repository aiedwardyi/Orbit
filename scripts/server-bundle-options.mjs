// esbuild options every packaged server build shares. server-bundle-options.test.mjs
// builds with them too, so CI loads what the release ships.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// yaml's Node export is CommonJS and contains dynamic requires that cannot run
// after it is inlined into our ESM-only packaged server. Its browser export is
// the same pure-JS parser without those Node shims, so resolve only this package
// to that entry while leaving every other dependency on the Node condition.
const yamlEsmPlugin = {
  name: "yaml-esm",
  setup(build) {
    build.onResolve({ filter: /^yaml$/ }, () => ({
      path: join(root, "node_modules", "yaml", "browser", "index.js"),
    }));
  },
};

export const serverBundleOptions = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // ESM has no require, so without this every CommonJS dependency that loads a
  // builtin (acme-client, axios, node-forge) throws `Dynamic require of "crypto"`.
  banner: { js: 'import { createRequire as __winkCreateRequire } from "node:module"; const require = __winkCreateRequire(import.meta.url);' },
  plugins: [yamlEsmPlugin],
};
