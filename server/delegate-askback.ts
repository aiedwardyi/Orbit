import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export function asksSender(reply: string, senderName: string): boolean {
  if (!senderName) return false;
  const tree = fromMarkdown(reply, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const withoutUrls = reply.replace(/\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>]+/gi, (url) => " ".repeat(url.length));
  const prose: string[] = [];
  const walk = (node: typeof tree | (typeof tree)["children"][number]) => {
    if (node.type === "code" || node.type === "inlineCode" || node.type === "definition") return;
    if (node.type === "text" || node.type === "html") prose.push(withoutUrls.slice(node.position!.start.offset, node.position!.end.offset));
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(tree);
  const text = prose.join(" ");
  const name = senderName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${name}(?![\\p{L}\\p{N}_-])`, "iu").test(reply) && /[^\s.!?][^.!?]*\?/u.test(text);
}
