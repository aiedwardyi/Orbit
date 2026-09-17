import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import afterPack from "./after-pack.mjs";
import { LICENSE_FILES } from "./cua-linux-release.mjs";

const temporaryDirectories = [];

function fixture() {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-after-pack-"));
  temporaryDirectories.push(appOutDir);
  const resources = path.join(appOutDir, "resources");
  const cua = path.join(resources, "cua-linux-x64");
  const licenses = path.join(cua, "licenses");
  fs.mkdirSync(licenses, { recursive: true, mode: 0o775 });
  for (const directory of [appOutDir, resources, cua, licenses]) fs.chmodSync(directory, 0o775);
  for (const name of ["cua-driver", "cua-cursor-theme", "release.json"]) {
    fs.writeFileSync(path.join(cua, name), "fixture", { mode: 0o664 });
    fs.chmodSync(path.join(cua, name), 0o664);
  }
  for (const name of LICENSE_FILES) {
    fs.writeFileSync(path.join(licenses, name), "fixture", { mode: 0o664 });
    fs.chmodSync(path.join(licenses, name), 0o664);
  }
  return { appOutDir, resources, cua, licenses };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("Linux afterPack permissions", () => {
  it("repairs every packaged CUA ancestor and resource mode", async () => {
    const { appOutDir, resources, cua, licenses } = fixture();

    await afterPack({ electronPlatformName: "linux", appOutDir });

    for (const directory of [appOutDir, resources, cua, licenses]) {
      expect(fs.lstatSync(directory).mode & 0o777).toBe(0o755);
    }
    for (const name of ["cua-driver", "cua-cursor-theme"]) {
      expect(fs.lstatSync(path.join(cua, name)).mode & 0o777).toBe(0o755);
    }
    expect(fs.lstatSync(path.join(cua, "release.json")).mode & 0o777).toBe(0o644);
    for (const name of fs.readdirSync(licenses)) {
      expect(fs.lstatSync(path.join(licenses, name)).mode & 0o777).toBe(0o644);
    }
  });

  it("fails closed when the runtime root is replaced by a symlink", async () => {
    const { appOutDir, cua } = fixture();
    const replacement = path.join(appOutDir, "replacement");
    fs.mkdirSync(replacement);
    fs.rmSync(cua, { recursive: true });
    fs.symlinkSync(replacement, cua, "dir");
    await expect(afterPack({ electronPlatformName: "linux", appOutDir })).rejects.toThrow(
      "must be a real directory",
    );
  });

  it("fails closed when the release manifest is missing", async () => {
    const { appOutDir, cua } = fixture();
    fs.unlinkSync(path.join(cua, "release.json"));
    await expect(afterPack({ electronPlatformName: "linux", appOutDir })).rejects.toThrow();
  });

  it("leaves non-Linux package modes unchanged", async () => {
    const { appOutDir, cua } = fixture();
    await afterPack({ electronPlatformName: "darwin", appOutDir });
    expect(fs.lstatSync(cua).mode & 0o777).toBe(0o775);
    expect(fs.lstatSync(path.join(cua, "cua-driver")).mode & 0o777).toBe(0o664);
  });
});

describe("Windows ConPTY resources", () => {
  it("requires the native module and bundled ConPTY helpers when present", async () => {
    const { appOutDir, resources } = fixture();
    const release = path.join(resources, "terminal", "node-pty", "build", "Release");
    const conpty = path.join(release, "conpty");
    fs.mkdirSync(conpty, { recursive: true });
    for (const file of [path.join(release, "conpty.node"), path.join(conpty, "conpty.dll"), path.join(conpty, "OpenConsole.exe")]) {
      fs.writeFileSync(file, "fixture");
    }

    await afterPack({ electronPlatformName: "win32", appOutDir });
    fs.unlinkSync(path.join(conpty, "conpty.dll"));
    await expect(afterPack({ electronPlatformName: "win32", appOutDir })).rejects.toThrow("conpty.dll");
  });

  it("rejects symlinked terminal ancestry", async () => {
    const { appOutDir, resources } = fixture();
    const terminal = path.join(resources, "terminal");
    const target = path.join(appOutDir, "terminal-target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, terminal, "junction");
    await expect(afterPack({ electronPlatformName: "win32", appOutDir })).rejects.toThrow("real directory");
  });

  it("rejects a symlinked node-pty build directory", async () => {
    const { appOutDir, resources } = fixture();
    const root = path.join(resources, "terminal", "node-pty");
    const release = path.join(root, "build-target", "Release", "conpty");
    fs.mkdirSync(release, { recursive: true });
    for (const file of [path.join(release, "..", "conpty.node"), path.join(release, "conpty.dll"), path.join(release, "OpenConsole.exe")]) {
      fs.writeFileSync(file, "fixture");
    }
    fs.symlinkSync(path.join(root, "build-target"), path.join(root, "build"), "junction");
    await expect(afterPack({ electronPlatformName: "win32", appOutDir })).rejects.toThrow("real directory");
  });
});
