import { describe, expect, it } from "vitest";
import { adjacentMedia, markdownImage, mediaList, type MediaMessage } from "./media-viewer";

const user = (id: string, name: string): MediaMessage => ({ id, role: "user", kind: "text", text: `<attached-image path="/saved/${name}" />` });
const shown = (id: string, name: string): MediaMessage => ({ id, role: "bot", kind: "screen", image: name });

describe("active chat media", () => {
  it.each(["bot", "group"])("keeps loaded %s branch order across sent, shown and markdown images", () => {
    const messages = [user("m1", "first.png"), shown("m2", "second.png"), { id: "m3", role: "bot", kind: "text", text: "![Detail](/api/attachments/third.png)" }];
    expect(mediaList(messages).map((image) => image.name)).toEqual(["first.png", "second.png", "third.png"]);
    expect(mediaList(messages.slice(0, 2)).map((image) => image.messageId)).toEqual(["m1", "m2"]);
  });

  it("does not duplicate a source repeated in its caption or markdown", () => {
    expect(mediaList([user("m1", "first.png"), shown("m2", "first.png"), { id: "m3", role: "bot", kind: "text", text: "![Again](/api/attachments/first.png)" }])).toHaveLength(1);
  });

  it("keeps the current reference stable when new messages arrive or older messages are loaded", () => {
    const loaded = [user("m2", "current.png"), shown("m3", "next.png")];
    const current = mediaList(loaded)[0];
    const updated = mediaList([user("m1", "older.png"), ...loaded, shown("m4", "new.png")]);
    expect(updated.find((image) => image.id === current.id)).toEqual(current);
    expect(adjacentMedia(updated, current, 1)?.name).toBe("next.png");
    expect(adjacentMedia(updated, current, -1)?.name).toBe("older.png");
    expect(adjacentMedia(mediaList(loaded), current, -1)).toBeUndefined();
  });

  it("includes only rendered validated linked images from messages in this chat", () => {
    const linked = { id: "m1:/api/threads/chat/linked-file?path=detail.png", messageId: "m1", src: "/api/threads/chat/linked-file?path=detail.png", name: "detail.png" };
    expect(mediaList([user("m1", "first.png")], [linked]).map((image) => image.name)).toEqual(["first.png", "detail.png"]);
    expect(mediaList([user("other", "first.png")], [linked])).toHaveLength(1);
  });

  it("uses markdown image references and skips executable URLs and raw worker reports", () => {
    const text = "![Detail][a]\n\n[a]: /api/attachments/detail.png\n\n![Bad](javascript:alert)\n\n`![Code](/api/attachments/code.png)`";
    expect(mediaList([{ id: "m1", kind: "text", role: "bot", text }]).map((image) => image.name)).toEqual(["detail.png"]);
    expect(mediaList([{ id: "worker", kind: "activity", role: "bot", text }])).toEqual([]);
    expect(markdownImage("javascript:alert(1)")).toBeNull();
    expect(markdownImage("data:image/svg+xml,anything")).toBeNull();
  });
});
