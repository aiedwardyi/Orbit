import assert from "node:assert/strict";
import test from "node:test";

import { companionParkedOnDesktop } from "./companion-policy.mjs";

test("parks companion only on packaged Windows", () => {
  assert.equal(companionParkedOnDesktop({ platform: "win32", packaged: true }), true);
  assert.equal(companionParkedOnDesktop({ platform: "win32", packaged: false }), false);
  assert.equal(companionParkedOnDesktop({ platform: "darwin", packaged: true }), false);
  assert.equal(companionParkedOnDesktop({ platform: "linux", packaged: true }), false);
});
