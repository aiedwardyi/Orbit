import { fromMarkdown } from "mdast-util-from-markdown";
import { defaultUrlTransform } from "react-markdown";
import { attachmentBasename, attachmentImageUrl, splitAttachedImages } from "./composer-attachments";
import { isShownMessage } from "./shown-message";

export interface PreviewImage {
  src: string;
  name: string;
  caption?: string;
}

export interface MediaReference extends PreviewImage {
  id: string;
  messageId: string;
}

export interface MediaMessage {
  id: string;
  role: string;
  kind: string;
  text?: string;
  image?: string;
}

export function previewImage(path: string): PreviewImage | null {
  const src = attachmentImageUrl(path);
  return src ? { src, name: attachmentBasename(path) } : null;
}

export function markdownImage(src: string | undefined, alt = ""): PreviewImage | null {
  if (!src || defaultUrlTransform(src) !== src || (/^[a-z][a-z\d+.-]*:/i.test(src) && !/^https?:\/\//i.test(src))) return null;
  const [path, query] = src.split(/[?#]/);
  const name = attachmentBasename(path.endsWith("/linked-file") ? new URLSearchParams(query).get("path") ?? path : path);
  return { src, name: name || alt || src, caption: alt || undefined };
}

export function mediaList(messages: readonly MediaMessage[], rendered: readonly MediaReference[] = []): MediaReference[] {
  const result: MediaReference[] = [];
  for (const message of messages) {
    if (!isShownMessage(message)) continue;
    const seen = new Set<string>();
    const add = (image: PreviewImage | null) => {
      if (!image || seen.has(image.src)) return;
      seen.add(image.src);
      result.push({ ...image, messageId: message.id, id: `${message.id}:${image.src}` });
    };
    if (message.image) {
      const image = previewImage(message.image);
      if (image) add({ ...image, caption: message.text });
    }
    if (message.kind === "text" && message.text) {
      if (message.role === "user") splitAttachedImages(message.text).images.forEach((path) => add(previewImage(path)));
      else {
        const tree = fromMarkdown(message.text);
        const definitions = new Map<string, string>();
        const visit = (node: typeof tree | (typeof tree.children)[number], images: boolean) => {
          if (!images && node.type === "definition") definitions.set(node.identifier, node.url);
          if (images && node.type === "image") add(markdownImage(node.url, node.alt ?? ""));
          if (images && node.type === "imageReference") add(markdownImage(definitions.get(node.identifier), node.alt ?? ""));
          if ("children" in node) node.children.forEach((child) => visit(child, images));
        };
        visit(tree, false);
        visit(tree, true);
      }
    }
    rendered.filter((image) => image.messageId === message.id).forEach(add);
  }
  return result;
}

export function adjacentMedia(images: readonly MediaReference[], current: PreviewImage, direction: number): MediaReference | undefined {
  const index = images.findIndex((image) => "id" in current ? image.id === current.id : image.src === current.src);
  return index < 0 ? undefined : images[index + direction];
}
