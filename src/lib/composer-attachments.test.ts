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
  isImageFile,
  splitAttachedImages,
  visibleComposerNotice,
  type ImageAttachment,
} from "./composer-attachments";

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

  it("leaves plain text and other tags untouched", () => {
    const stored = '<pasted-text index="1">\nhi\n</pasted-text>';
    const { display, images } = splitAttachedImages(stored);
    expect(display).toBe(stored);
    expect(images).toEqual([]);
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
    unsupported: "The selected responder does not support image attachments.",
    loading: "Engine details are still loading.",
  };

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
