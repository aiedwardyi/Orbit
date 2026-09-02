import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("packaging identity", () => {
  it("owns the auto-update feed, publisher, and homepage", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const builder = readFileSync(path.join(root, "electron-builder.yml"), "utf8");
    const workflow = readFileSync(path.join(root, ".github/workflows/package-win.yml"), "utf8");

    assert.equal(pkg.author.name, "Edward Yi");
    assert.notEqual(pkg.author.name, "Milind Soni");
    assert.equal(pkg.homepage, "https://github.com/aiedwardyi/Orbit");
    assert.equal(pkg.repository.url, "https://github.com/aiedwardyi/Orbit.git");
    assert.equal(pkg.version, "1.0.0");

    assert.match(builder, /^    owner: aiedwardyi$/m);
    assert.match(builder, /^    repo: orbit-releases$/m);
    assert.match(builder, /^    schemes: \[orbit\]$/m);
    assert.doesNotMatch(builder, /milind-soni/);
    assert.doesNotMatch(builder, /openmausbot-releases/);
    assert.doesNotMatch(builder, /schemes: \[openmausbot\]/);

    assert.match(workflow, /owner: aiedwardyi/);
    assert.match(workflow, /repo: orbit-releases/);
    assert.doesNotMatch(workflow, /grep -q "openmausbot-releases"/);
  });
});
