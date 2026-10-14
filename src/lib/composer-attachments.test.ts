// composeMessage with images, the image tag round-trip through
// splitAttachedImages, and the mime gate the composer pastes through.
import { describe, expect, it } from "vitest";

import {
  appendPastedText,
  attachmentBasename,
  attachmentImageUrl,
  composeMessage,
  imageSupportForTargets,
  imageSupportNotice,
  intakeFiles,
  isAttachment,
  isImageFile,
  pasteAttachment,
  pasteImageAttachment,
  splitAttachedImages,
  visibleComposerNotice,
  type ImageAttachment,
  type UploadAttachment,
} from "./composer-attachments";
import { getDraftAttachments } from "./drafts";
import { t } from "./i18n";

/** Exercises the spacing and empty-draft cases for pasted text insertion. */
function appendPastedTextTests() {
  /** Keeps an existing draft ahead of newly inserted pasted content. */
  function addsPastedContentAfterDraft() {
    expect(appendPastedText("Keep this", "Edit this too")).toBe("Keep this\n\nEdit this too");
  }

  /** Avoids duplicating a separator when the draft already ends with a newline. */
  function preservesExistingTrailingNewline() {
    expect(appendPastedText("Keep this\n", "Edit this too")).toBe("Keep this\nEdit this too");
  }

  /** Inserts pasted content directly when no draft exists yet. */
  function insertsIntoEmptyDraft() {
    expect(appendPastedText("", "Edit this too")).toBe("Edit this too");
  }

  it("adds pasted content after an existing draft", addsPastedContentAfterDraft);
  it("does not add a second separator when the draft ends with a newline", preservesExistingTrailingNewline);
  it("uses the pasted content directly for an empty draft", insertsIntoEmptyDraft);
}

describe("appendPastedText", appendPastedTextTests);

/** Builds a stable image attachment fixture for prompt and preview tests. */
function image(path: string): ImageAttachment {
  return {
    kind: "image",
    id: "i1",
    path,
    name: "shot.png",
    size: 1234,
    mime: "image/png",
  };
}

describe("composeMessage with images", () => {
  it("emits an attached-image tag carrying the server path", () => {
    const prompt = composeMessage("what is this?", [image("/home/u/.orbit/attachments/abc.png")]);
    expect(prompt).toBe(
      'what is this?\n\n<attached-image path="/home/u/.orbit/attachments/abc.png" />',
    );
  });

  it("escapes a hostile path the same way file paths are escaped", () => {
    const prompt = composeMessage("", [image('/x/")} onload="evil()')]);
    // every quote is entity-encoded, so the payload can never break out of
    // the attribute — the tag stays one well-formed element
    expect(prompt).toMatch(/<attached-image path="[^"]*" \/>/);
    expect(prompt).toContain("&quot;");
  });
});

describe("splitAttachedImages", () => {
  it("splits tags out of a stored message and returns the paths", () => {
    const stored =
      'look at this\n\n<attached-image path="/a/b/one.png" />\n\n<attached-image path="/a/b/two.jpg" />';
    const { display, images } = splitAttachedImages(stored);
    expect(display).toBe("look at this");
    expect(images).toEqual(["/a/b/one.png", "/a/b/two.jpg"]);
  });

  it("unescapes attribute entities so the path round-trips", () => {
    const stored = '<attached-image path="/a/b/&amp;x.png" />';
    const { images } = splitAttachedImages(stored);
    expect(images).toEqual(["/a/b/&x.png"]);
  });

  it("unboxes pasted-text tags for display", () => {
    const stored = 'intro\n\n<pasted-text index="1">\nhello world\n</pasted-text>\n\noutro';
    const { display, images } = splitAttachedImages(stored);
    expect(display).toBe("intro\n\nhello world\n\noutro");
    expect(images).toEqual([]);
  });

  it("returns attached files for new and old tags and keeps them out of the text", () => {
    const stored =
      'take a look\n\n<attached-file path="C:\\Users\\mredw\\Downloads\\image_123.png" />\n\n' +
      '<attached-file path="C:\\Users\\mredw\\Downloads\\Wink\\a &amp; b.mp4" name="a &amp; b.mp4" size="1717986918" type="video/mp4" />';
    const { display, images, files } = splitAttachedImages(stored);
    expect(display).toBe("take a look");
    expect(display).not.toContain("<attached-file");
    expect(display).not.toContain("[attachment:");
    expect(images).toEqual([]);
    expect(files).toEqual([
      { path: "C:\\Users\\mredw\\Downloads\\image_123.png", name: "image_123.png" },
      { path: "C:\\Users\\mredw\\Downloads\\Wink\\a & b.mp4", name: "a & b.mp4", size: 1717986918 },
    ]);
  });

  it("keeps a literal attached-image tag inside pasted-text", () => {
    const inner = '<attached-image path="a.png" />';
    const { display, images } = splitAttachedImages(composeMessage("", [pasteAttachment(inner)]));
    expect(display).toBe(inner);
    expect(images).toEqual([]);
  });

  it("keeps a literal attached-file tag inside pasted-text", () => {
    const inner = '<attached-file path="b.txt" />';
    const { display, images } = splitAttachedImages(composeMessage("", [pasteAttachment(inner)]));
    expect(display).toBe(inner);
    expect(images).toEqual([]);
  });
});

describe("pasteImageAttachment", () => {
  it("uses an injected uploader instead of posting the file", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const attachment = await pasteImageAttachment(file, true, async () => ({
      path: "/tmp/shot.png",
      mime: "image/png",
      bytes: 3,
    }));
    expect(attachment).toMatchObject({
      kind: "image",
      path: "/tmp/shot.png",
      name: "shot.png",
      size: 3,
      mime: "image/png",
    });
  });

  it("still uploads a pathless paste for an engine that cannot read images inline", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const attachment = await pasteImageAttachment(file, false, async () => ({
      path: "/tmp/shot.png",
      mime: "image/png",
      bytes: 3,
    }));
    expect(attachment).toMatchObject({ kind: "file", path: "/tmp/shot.png", name: "shot.png", size: 3 });
  });
});

describe("attachmentBasename", () => {
  it("takes the final path segment on POSIX and Windows separators", () => {
    expect(attachmentBasename("/a/b/c.png")).toBe("c.png");
    expect(attachmentBasename("C:\\a\\b\\c.png")).toBe("c.png");
  });

  it("turns only generated image names into same-origin preview URLs", () => {
    expect(attachmentImageUrl("/a/b/123e4567-e89b-12d3-a456-426614174000.png")).toBe(
      "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png",
    );
    expect(attachmentImageUrl("C:\\a\\b\\photo.webp")).toBe("/api/attachments/photo.webp");
    expect(attachmentImageUrl("https://attacker.example/tracker.png?cookie=1")).toBeNull();
    expect(attachmentImageUrl("/a/b/payload.svg")).toBeNull();
    expect(attachmentImageUrl("/a/b/not%2Fan-image.png")).toBeNull();
  });
});

describe("isImageFile", () => {
  it("accepts the served image mimes and rejects others", () => {
    expect(isImageFile({ type: "image/png", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/jpeg", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/webp", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/svg+xml", size: 10 })).toBe(false);
    expect(isImageFile({ type: "text/plain", size: 10 })).toBe(false);
  });
});

describe("imageSupportForTargets", () => {
  const imageBot = { modelSelection: { instanceId: "claude" } };
  const textBot = { modelSelection: { instanceId: "grok" } };

  it("reports supported when every target supports images", () => {
    const instances = [{ instanceId: "claude", capabilities: { images: true } }];
    expect(imageSupportForTargets(instances, [imageBot])).toBe("supported");
  });

  it("reports unsupported for a known unsupported target", () => {
    const instances = [{ instanceId: "grok", capabilities: { images: false } }];
    expect(imageSupportForTargets(instances, [textBot])).toBe("unsupported");
  });

  it("reports unknown before instance details load", () => {
    expect(imageSupportForTargets([], [imageBot])).toBe("unknown");
  });

  it("keeps mixed groups unsupported when any known target refuses images", () => {
    const instances = [{ instanceId: "grok", capabilities: { images: false } }];
    expect(imageSupportForTargets(instances, [imageBot, textBot])).toBe("unsupported");
  });

  it("reports unsupported when no responder is selected", () => {
    expect(imageSupportForTargets([], [])).toBe("unsupported");
  });
});

describe("image attachment notice", () => {
  const copy = {
    unsupported: "Direct image attachments are not supported by this engine.",
    loading: "Engine details are still loading.",
  };

  it("does not blame the responder in the unsupported copy", () => {
    expect(copy.unsupported).not.toMatch(/responder/i);
  });

  it("returns the unsupported copy for a known refusal", () => {
    expect(imageSupportNotice("unsupported", copy)).toBe(copy.unsupported);
  });

  it("returns the loading copy while the engine is still hydrating", () => {
    expect(imageSupportNotice("unknown", copy)).toBe(copy.loading);
  });

  it("returns nothing when images are supported", () => {
    expect(imageSupportNotice("supported", copy)).toBeNull();
  });

  it("does not carry a notice into a different conversation", () => {
    const notice = { threadId: "pim", text: copy.unsupported };
    expect(visibleComposerNotice(notice, "pim")).toBe(copy.unsupported);
    expect(visibleComposerNotice(notice, "nova")).toBeNull();
    expect(visibleComposerNotice(null, "pim")).toBeNull();
  });
});

describe("composeMessage with files", () => {
  it("emits escaped name, size and type on attached-file", () => {
    const prompt = composeMessage("", [
      { kind: "file", id: "f1", path: "C:\\x\\a.mp4", name: 'a"<b>.mp4', size: 5, type: "video/mp4" },
    ]);
    expect(prompt).toBe('<attached-file path="C:\\x\\a.mp4" name="a&quot;&lt;b&gt;.mp4" size="5" type="video/mp4" />');
    expect(splitAttachedImages(prompt).files).toEqual([{ path: "C:\\x\\a.mp4", name: 'a"<b>.mp4', size: 5 }]);
  });
});

describe("big file intake", () => {
  type Fake = Pick<File, "name" | "size" | "type" | "text" | "arrayBuffer" | "lastModified">;
  const fake = (name: string, size: number, type = ""): Fake => ({
    name,
    size,
    type,
    lastModified: 7,
    text: async () => "",
    arrayBuffer: async () => {
      throw new Error("must not read");
    },
  });
  const intake = (files: Fake[]) =>
    intakeFiles(files, {
      t,
      allowImages: true,
      getPath: () => "",
      uploadImage: async () => {
        throw new Error("must not upload as an image");
      },
    });

  it("turns pathless big files into upload chips and refuses over 10 GB", async () => {
    const meeting = fake("meeting.mp4", 1.6e9, "video/mp4");
    const docx = fake("plan.docx", 30 * 1024 * 1024);
    const huge = fake("huge.iso", 10 * 1024 ** 3 + 1);
    const out = await intake([meeting, docx, huge]);
    expect(out.attachments).toEqual([
      expect.objectContaining({ kind: "upload", name: "meeting.mp4", size: 1.6e9, type: "video/mp4", lastModified: 7, state: "uploading" }),
      expect.objectContaining({ kind: "upload", name: "plan.docx" }),
    ]);
    expect(out.uploads.map((upload) => upload.file)).toEqual([meeting, docx]);
    expect(out.uploads.map((upload) => upload.id)).toEqual(out.attachments.map((a) => a.id));
    expect(out.notice).toBe(t("composer.uploadTooBig", { name: "huge.iso" }));
  });

  it("keeps an oversized image with a path as a file chip", async () => {
    const out = await intakeFiles([fake("big.png", 11 * 1024 * 1024, "image/png")], {
      t,
      allowImages: true,
      getPath: (file) => `C:\\pics\\${file.name}`,
      uploadImage: async () => {
        throw new Error("must not upload");
      },
    });
    expect(out.attachments).toEqual([expect.objectContaining({ kind: "file", path: "C:\\pics\\big.png", type: "image/png" })]);
    expect(out.uploads).toEqual([]);
  });
});

describe("upload chips in drafts", () => {
  const chip: UploadAttachment = {
    kind: "upload",
    id: "u1",
    uploadId: "0f0e0d0c-0b0a-4000-8000-000000000001",
    name: "meeting.mp4",
    size: 1.6e9,
    type: "video/mp4",
    lastModified: 7,
    sent: 8388608,
    state: "uploading",
  };

  it("accepts an upload chip and restores it as repick", () => {
    expect(isAttachment(chip)).toBe(true);
    const values: Record<string, string> = {};
    const store = { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => void (values[key] = value) };
    store.setItem("omb-draft-attachments", JSON.stringify({ d1: [chip] }));
    expect(getDraftAttachments(store, "d1")).toEqual([{ ...chip, state: "repick" }]);
  });
});
