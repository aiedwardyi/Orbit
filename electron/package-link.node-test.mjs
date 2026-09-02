import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PACKAGE_INSTALL_SCHEME,
  packageUrlFromCommandLine,
  packageUrlFromDeepLink,
} from "./package-link.mjs";

describe("BotMRR package deep links", () => {
  it("accepts a public GitHub package URL on the Orbit scheme", () => {
    const target = "https://raw.githubusercontent.com/acme/bots/main/reddit-lead-miner.md";
    const link = `${PACKAGE_INSTALL_SCHEME}://install?url=${encodeURIComponent(target)}`;
    assert.equal(PACKAGE_INSTALL_SCHEME, "orbit");
    assert.equal(packageUrlFromDeepLink(link), target);
    assert.equal(packageUrlFromCommandLine(["Orbit", "--flag", link]), target);
  });

  it("rejects the legacy OpenMausBot scheme and other invalid links", () => {
    const target = "https://raw.githubusercontent.com/acme/bots/main/reddit-lead-miner.md";
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent(target)}`), null);
    assert.equal(packageUrlFromDeepLink("orbit://settings"), null);
    assert.equal(packageUrlFromDeepLink("orbit://install?url=https://evil.example/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("orbit://install?url=http://raw.githubusercontent.com/a/b/main/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("orbit://install?url=https://user@example.com/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("orbit://install?url=https://github.com/acme/bot/run.sh"), null);
  });
});
