import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spoolTeamSnag } from "./team-snags.mjs";

test("a failed rename removes the unscreened temporary spool", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-snags-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(fs, "renameSync", () => { throw new Error("rename failed"); });
  assert.equal(spoolTeamSnag(dir, () => true, { event: "stalled", key: "pane", tail: "private output" }), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a snag is spooled only into an open queue with the switch on", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-snags-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "team-snags");
  const snag = { event: "stalled", key: "pane-1", label: "W" };
  assert.equal(spoolTeamSnag(dir, () => true, snag), false);
  fs.mkdirSync(dir);
  assert.equal(spoolTeamSnag(dir, () => false, snag), false);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(spoolTeamSnag(dir, () => true, snag, () => 1_000), true);
  const [name] = fs.readdirSync(dir);
  assert.match(name, /^1000-[0-9a-f]{32}\.json$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")), { ...snag, id: name.slice(5, 37), at: 1_000 });
});
