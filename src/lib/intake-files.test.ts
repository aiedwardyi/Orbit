import { afterEach, describe, expect, it, vi } from "vitest";

import { composeMessage, intakeFiles, pasteImageAttachment, type Attachment } from "./composer-attachments";
import { applyLocale, t } from "./i18n";

type Fake = Pick<File, "name" | "size" | "type" | "text" | "arrayBuffer">;
const file = (name: string, type: string, size = 10): Fake => ({
  name,
  size,
  type,
  text: async () => "contents",
  arrayBuffer: async () => new ArrayBuffer(size),
});
const upload = async (f: Fake): Promise<Attachment> => ({
  kind: "image",
  id: `id-${f.name}`,
  name: f.name,
  path: `/api/attachments/${f.name}`,
  size: f.size,
  mime: f.type,
});
const onDisk = (f: Fake) => `/Users/me/${f.name}`;

afterEach(() => {
  vi.unstubAllGlobals();
  applyLocale("en");
});

describe("browser document intake", () => {
  it.each(["pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "txt", "md", "csv", "json"])("uploads a pathless .%s as a file chip", async (ext) => {
    const saved = { path: `/host/attachments/random.${ext}`, name: `윙크.${ext}`, bytes: 8, mime: "application/octet-stream" };
    const fetcher = vi.fn(async () => Response.json(saved, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    const picked = new File(["contents"], `윙크.${ext}`);
    const out = await intakeFiles([picked], { t, allowImages: false, getPath: () => "", uploadImage: pasteImageAttachment });
    expect(fetcher).toHaveBeenCalledWith("/api/attachments", expect.objectContaining({
      method: "POST",
      headers: new Headers({ "content-type": "application/octet-stream", "x-attachment-name": encodeURIComponent(picked.name) }),
      body: new TextEncoder().encode("contents"),
    }));
    expect(out.attachments).toEqual([expect.objectContaining({ kind: "file", path: saved.path, name: saved.name, size: 8 })]);
    expect(composeMessage("read", out.attachments)).toContain(`<attached-file path="${saved.path}" />`);
    expect(out.notice).toBeNull();
  });

  it.each(["en", "ko"] as const)("localizes refused types and oversized documents in %s", async (locale) => {
    applyLocale(locale);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const out = await intakeFiles([file("big.docx", "", 25 * 1024 * 1024 + 1), file("script.html", "text/html")], {
      t, allowImages: true, getPath: () => "", uploadImage: upload,
    });
    expect(out.attachments).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.notice).toContain("big.docx");
    expect(out.notice).toContain("script.html");
    expect(out.notice).toContain("25 MB");
    expect(out.notice).toContain(locale === "ko" ? "첨부" : "Supported");
    expect(out.notice).not.toMatch(/Finder|File Explorer/);
  });

  it("keeps desktop paths even for unsupported types and large documents", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const out = await intakeFiles([file("big.docx", "", 30 * 1024 * 1024), file("script.html", "text/html")], {
      t, allowImages: false, getPath: onDisk, uploadImage: upload,
    });
    expect(out.attachments.map((a) => a.kind)).toEqual(["file", "file"]);
    expect(out.notice).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps successful files in order when a document upload fails", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "disk full" }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ path: "/host/random.txt", name: "notes.txt", bytes: 8, mime: "application/octet-stream" })));
    const out = await intakeFiles([file("bad.docx", ""), file("notes.txt", "text/plain"), file("shot.png", "image/png")], {
      t, allowImages: true, getPath: () => "", uploadImage: upload,
    });
    expect(out.attachments.map((a) => "name" in a && a.name)).toEqual(["notes.txt", "shot.png"]);
    expect(out.notice).toContain("bad.docx");
  });
});

describe("intakeFiles", () => {
  it("uploads images and keeps ordinary files as paths", async () => {
    const out = await intakeFiles([file("shot.png", "image/png"), file("notes.txt", "text/plain")], {
      t, allowImages: true,
      getPath: onDisk,
      uploadImage: upload,
    });
    expect(out.attachments.map((a) => [a.kind, "name" in a ? a.name : ""])).toEqual([
      ["image", "shot.png"],
      ["file", "notes.txt"],
    ]);
    expect(out.notice).toBeNull();
  });

  it("treats an image as an ordinary file when the engine cannot read one", async () => {
    const out = await intakeFiles([file("shot.png", "image/png")], {
      t, allowImages: false,
      getPath: onDisk,
      uploadImage: async () => {
        throw new Error("must not upload");
      },
    });
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].kind).toBe("file");
  });

  it("names the files it could not take, rather than dropping them in silence", async () => {
    const out = await intakeFiles([{ ...file("ghost.bin", "application/octet-stream", 999_999_999) }], {
      t, allowImages: true,
      getPath: () => "",
      uploadImage: upload,
    });
    expect(out.attachments).toHaveLength(0);
    expect(out.notice).toMatch(/ghost\.bin/);
  });

  it("keeps a small pathless text file outside the document types as a paste chip", async () => {
    const out = await intakeFiles([file("notes.log", "text/plain")], { t, allowImages: false, getPath: () => "", uploadImage: upload });
    expect(out.attachments.map((attachment) => attachment.kind)).toEqual(["paste"]);
    expect(out.notice).toBeNull();
  });

  it("reports an upload that failed without losing the files that worked", async () => {
    const out = await intakeFiles([file("ok.png", "image/png"), file("bad.png", "image/png")], {
      t, allowImages: true,
      getPath: onDisk,
      uploadImage: async (f) => {
        if (f.name === "bad.png") throw new Error("too large");
        return upload(f);
      },
    });
    expect(out.attachments).toHaveLength(1);
    expect(out.notice).toMatch(/bad\.png: too large/);
  });

  it("uploads a pathless image for an engine that reads images inline", async () => {
    const out = await intakeFiles([file("shot.png", "image/png")], {
      t, allowImages: true,
      getPath: () => "",
      uploadImage: upload,
    });
    expect(out.attachments).toEqual([expect.objectContaining({ kind: "image", name: "shot.png" })]);
    expect(out.notice).toBeNull();
  });

  it("uploads a pathless image as a file chip for an engine that cannot read images", async () => {
    const out = await intakeFiles([file("shot.png", "image/png")], {
      t, allowImages: false,
      getPath: () => "",
      uploadImage: async (f, allowImages): Promise<Attachment> => {
        if (allowImages) return upload(f);
        return { kind: "file", id: `id-${f.name}`, name: f.name, path: `/api/attachments/${f.name}`, size: f.size };
      },
    });
    expect(out.attachments).toEqual([expect.objectContaining({ kind: "file", name: "shot.png" })]);
    expect(out.notice).toBeNull();
  });
});
