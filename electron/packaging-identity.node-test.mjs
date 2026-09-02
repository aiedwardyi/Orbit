import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

describe("packaging identity", () => {
  it("owns the auto-update feed, publisher, and homepage", () => {
    const pkg = JSON.parse(read("package.json"));
    const builder = read("electron-builder.yml");
    const workflow = read(".github/workflows/package-win.yml");

    assert.equal(pkg.author.name, "Edward Yi");
    assert.notEqual(pkg.author.name, "Milind Soni");
    assert.equal(pkg.homepage, "https://github.com/aiedwardyi/Orbit");
    assert.equal(pkg.repository.url, "https://github.com/aiedwardyi/Orbit.git");
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.notEqual(pkg.version, "1.0.0");

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

  it("publishes the Windows release job to aiedwardyi/orbit-releases", () => {
    const release = read(".github/workflows/release.yml");

    assert.match(release, /--repo aiedwardyi\/orbit-releases/);
    assert.match(release, /grep -q "repo: orbit-releases"/);
    assert.doesNotMatch(release, /milind-soni\/openmausbot-releases/);
    assert.doesNotMatch(release, /grep -q "openmausbot-releases"/);
    assert.doesNotMatch(release, /milind-soni\/OpenMausBot/);
  });

  it("does not ship packaged phone-home defaults to Milind-hosted services", () => {
    const main = read("electron/main.mjs");
    const composio = read("electron/managed-composio.mjs");
    const companion = read("electron/companion-account-service.mjs");

    assert.doesNotMatch(main, /milindsoni201\.workers\.dev/);
    assert.doesNotMatch(composio, /milindsoni201\.workers\.dev/);
    assert.doesNotMatch(main, /accounts\.openmausbot\.com/);
    assert.doesNotMatch(composio, /accounts\.openmausbot\.com/);
    assert.doesNotMatch(companion, /accounts\.openmausbot\.com/);
    assert.doesNotMatch(
      companion,
      /isPackaged \? DEFAULT_COMPANION_CONTROL_PLANE_URL/,
    );
    assert.match(main, /startUpdater\(win\)/);
  });

  it("expects DEB metadata to match the Orbit maintainer", () => {
    const linuxVerify = read("scripts/verify-linux-package.mjs");
    const builder = read("electron-builder.yml");

    assert.match(builder, /^  maintainer: Edward Yi /m);
    assert.match(linuxVerify, /"Maintainer: Edward Yi"/);
    assert.doesNotMatch(linuxVerify, /Maintainer: Milind Soni/);
  });
});
