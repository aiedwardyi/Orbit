import assert from "node:assert/strict";
import test from "node:test";

import { readClipboardImage } from "./clipboard-image.mjs";

const fakeClipboard = (reads) => {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    readImage: () => {
      const png = reads[calls++];
      return { isEmpty: () => !png, toPNG: () => png };
    },
  };
};

test("returns the PNG once a busy clipboard reads back", async () => {
  const png = Buffer.from([137, 80, 78, 71]);
  const clipboard = fakeClipboard([null, null, png]);
  const waits = [];
  assert.equal(await readClipboardImage(clipboard, async (ms) => waits.push(ms)), png);
  assert.equal(clipboard.calls, 3);
  assert.deepEqual(waits, [100, 200]);
});

test("gives up with null when no image comes back", async () => {
  const clipboard = fakeClipboard([]);
  const waits = [];
  assert.equal(await readClipboardImage(clipboard, async (ms) => waits.push(ms)), null);
  assert.equal(clipboard.calls, 4);
  assert.deepEqual(waits, [100, 200, 400]);
});
