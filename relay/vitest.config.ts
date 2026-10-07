import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// shared/ sits outside this package; point its zod import at this package's copy.
const zod = fileURLToPath(new URL("./node_modules/zod", import.meta.url));

export default defineConfig({
  resolve: { alias: { zod } },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
