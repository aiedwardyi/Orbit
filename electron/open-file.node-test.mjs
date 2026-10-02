import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { openLocalFile } from "./open-file.mjs";

// Creating a symlink on Windows needs elevation or developer mode, so the
// symlink case only runs where the runner can actually make one.
const canSymlink = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "omb-symlink-probe-"));
  try {
    fs.symlinkSync(path.join(probe, "target"), path.join(probe, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

let dir;

const fakeShell = () => {
  const calls = [];
  return {
    calls,
    openPath: async (p) => {
      calls.push(["open", p]);
      return "";
    },
    showItemInFolder: (p) => calls.push(["reveal", p]),
  };
};

const file = (name) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "x");
  return p;
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-open-file-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("open-file policy", () => {
  it("opens an allowlisted type in its default app", async () => {
    for (const name of ["report.docx", "Scan.PDF", "photo.jpeg"]) {
      const shell = fakeShell();
      const p = file(name);
      assert.equal(await openLocalFile(p, { shell }), "open");
      assert.deepEqual(shell.calls, [["open", await fs.promises.realpath(p)]]);
    }
  });

  it("only reveals executables, scripts and extensionless files", async () => {
    for (const name of ["setup.exe", "run.ps1", "go.bat", "page.html", "README"]) {
      const shell = fakeShell();
      const p = file(name);
      assert.equal(await openLocalFile(p, { shell }), "reveal");
      assert.deepEqual(shell.calls, [["reveal", await fs.promises.realpath(p)]]);
    }
  });

  it("reveals a .pdf symlink that points at an .exe", { skip: !canSymlink }, async () => {
    const exe = file("payload.exe");
    const link = path.join(dir, "invoice.pdf");
    fs.symlinkSync(exe, link, "file");
    const shell = fakeShell();
    assert.equal(await openLocalFile(link, { shell }), "reveal");
    assert.deepEqual(shell.calls, [["reveal", await fs.promises.realpath(exe)]]);
  });

  it("judges the real path, not the link's name", async () => {
    const exe = file("real.exe");
    const fsp = { realpath: async () => exe, stat: fs.promises.stat };
    const shell = fakeShell();
    assert.equal(await openLocalFile(path.join(dir, "invoice.pdf"), { shell, fsp }), "reveal");
    assert.deepEqual(shell.calls, [["reveal", exe]]);
  });

  it("rejects a directory, a missing file and a relative path", async () => {
    const shell = fakeShell();
    await assert.rejects(openLocalFile(dir, { shell }), { message: "That path is not a file" });
    await assert.rejects(openLocalFile(path.join(dir, "gone.docx"), { shell }), { message: "That file no longer exists" });
    await assert.rejects(openLocalFile("report.docx", { shell }), { message: "That file path is invalid" });
    assert.deepEqual(shell.calls, []);
  });

  it("rejects UNC paths and alternate data streams on Windows", async () => {
    const shell = fakeShell();
    for (const p of ["\\\\evil\\share\\a.pdf", "//evil/share/a.pdf", "C:\\x\\a.exe:s.pdf"]) {
      await assert.rejects(openLocalFile(p, { shell, platform: "win32" }), { message: "That file path is invalid" });
    }
    assert.deepEqual(shell.calls, []);
  });

  it("keeps a relative link's file inside its bot folder", async () => {
    const bot = path.join(dir, "bot");
    fs.mkdirSync(bot);
    const own = path.join(bot, "notes.md");
    fs.writeFileSync(own, "x");
    const shell = fakeShell();
    assert.equal(await openLocalFile(own, { shell, base: bot }), "open");
    await assert.rejects(openLocalFile(file("other.md"), { shell, base: bot }), {
      message: "That file is outside the bot's folder",
    });
  });

  it("says so when the default app cannot open the file", async () => {
    const shell = { openPath: async () => "No application is associated", showItemInFolder: () => {} };
    await assert.rejects(openLocalFile(file("deck.pptx"), { shell }), { message: "That file could not be opened" });
  });
});
