import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { fileMenuFor, openLocalFile } from "./open-file.mjs";

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

  it("opens a folder in File Explorer", async () => {
    const shell = fakeShell();
    assert.equal(await openLocalFile(dir, { shell }), "folder");
    assert.deepEqual(shell.calls, [["open", await fs.promises.realpath(dir)]]);
  });

  it("only reveals a folder named as a shell view", async () => {
    const view = path.join(dir, "panel.{21EC2020-3AEA-1069-A2DD-08002B30309D}");
    fs.mkdirSync(view);
    const shell = fakeShell();
    assert.equal(await openLocalFile(view, { shell, platform: "win32" }), "reveal");
    assert.deepEqual(shell.calls, [["reveal", await fs.promises.realpath(view)]]);
  });

  it("opens a shell-view named folder as a plain folder off Windows", async () => {
    const view = path.join(dir, "panel.{21EC2020-3AEA-1069-A2DD-08002B30309E}");
    fs.mkdirSync(view);
    const shell = fakeShell();
    assert.equal(await openLocalFile(view, { shell, platform: "linux" }), "folder");
    assert.deepEqual(shell.calls, [["open", await fs.promises.realpath(view)]]);
  });

  it("rejects a missing file and a relative path", async () => {
    const shell = fakeShell();
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

  it("keeps a linked folder inside its bot folder", async () => {
    const bot = path.join(dir, "bot2");
    fs.mkdirSync(path.join(bot, "shots"), { recursive: true });
    fs.mkdirSync(path.join(dir, "elsewhere"));
    const shell = fakeShell();
    assert.equal(await openLocalFile(path.join(bot, "shots"), { shell, base: bot }), "folder");
    await assert.rejects(openLocalFile(path.join(dir, "elsewhere"), { shell, base: bot }), {
      message: "That file is outside the bot's folder",
    });
  });

  it("says so when the default app cannot open the file", async () => {
    const shell = { openPath: async () => "No application is associated", showItemInFolder: () => {} };
    await assert.rejects(openLocalFile(file("deck.pptx"), { shell }), { message: "That file could not be opened" });
  });

  it("says so when File Explorer cannot open the folder", async () => {
    const shell = { openPath: async () => "Access is denied", showItemInFolder: () => {} };
    await assert.rejects(openLocalFile(dir, { shell }), { message: "That folder could not be opened" });
  });
});

describe("file link menu", () => {
  const menuFor = (p, overrides = {}) => {
    const calls = [];
    const options = {
      text: (key) => key,
      shell: { showItemInFolder: (target) => calls.push(["reveal", target]) },
      clipboard: { writeText: (value) => calls.push(["clip", value]) },
      dialog: { showSaveDialog: async () => ({ canceled: true }) },
      downloads: dir,
      onSaveError: (error) => calls.push(["error", error.message]),
      ...overrides,
    };
    return { calls, menu: fileMenuFor(p, options) };
  };
  const click = (items, label) => items.find((item) => item.label === label).click();

  it("offers show, save and copy for a file", async () => {
    const p = file("clip.mp4");
    const real = await fs.promises.realpath(p);
    const { calls, menu } = menuFor(p);
    const items = await menu;
    assert.deepEqual(items.map((item) => item.label), ["native.showInFolder", "native.saveCopy", "native.copyPath"]);
    click(items, "native.showInFolder");
    click(items, "native.copyPath");
    assert.deepEqual(calls, [["reveal", real], ["clip", real]]);
  });

  it("leaves Save out for a folder", async () => {
    const { menu } = menuFor(dir);
    assert.deepEqual((await menu).map((item) => item.label), ["native.showInFolder", "native.copyPath"]);
  });

  it("copies to the chosen path and nothing on cancel", async () => {
    const p = file("report.pdf");
    const dest = path.join(dir, "copy-of-report.pdf");
    const asked = [];
    const pick = (result) => async (_window, options) => {
      asked.push(options.defaultPath);
      return result;
    };
    let items = await menuFor(p, { dialog: { showSaveDialog: pick({ canceled: true }) } }).menu;
    await click(items, "native.saveCopy");
    assert.equal(fs.existsSync(dest), false);
    items = await menuFor(p, { dialog: { showSaveDialog: pick({ canceled: false, filePath: dest }) } }).menu;
    await click(items, "native.saveCopy");
    assert.equal(fs.readFileSync(dest, "utf8"), "x");
    assert.deepEqual(asked, [path.join(dir, "report.pdf"), path.join(dir, "report.pdf")]);
  });

  it("reports a failed copy instead of throwing", async () => {
    const p = file("locked.pdf");
    const dest = path.join(dir, "no-such-folder", "locked.pdf");
    const { calls, menu } = menuFor(p, { dialog: { showSaveDialog: async () => ({ canceled: false, filePath: dest }) } });
    await click(await menu, "native.saveCopy");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "error");
  });

  it("never builds a menu for a rejected path", async () => {
    const dialog = { showSaveDialog: async () => assert.fail("no dialog") };
    await assert.rejects(menuFor(path.join(dir, "gone.mp4"), { dialog }).menu, { message: "That file no longer exists" });
    await assert.rejects(menuFor("clip.mp4", { dialog }).menu, { message: "That file path is invalid" });
    await assert.rejects(menuFor("//evil/share/a.mp4", { dialog, platform: "win32" }).menu, { message: "That file path is invalid" });
    await assert.rejects(menuFor(file("other.mp4"), { dialog, base: path.join(dir, "bot") }).menu, { message: "That file is outside the bot's folder" });
  });
});
