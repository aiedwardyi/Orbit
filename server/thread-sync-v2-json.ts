import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export interface LegacyField {
  key: string;
  child?: string;
  json: string;
}

export async function* readLegacyFields(path: string): AsyncGenerator<LegacyField, string> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const chunks = stream[Symbol.asyncIterator]();
  const hash = createHash("sha256");
  let buffer = "";
  let offset = 0;
  let ended = false;
  async function fill(): Promise<boolean> {
    if (offset < buffer.length) return true;
    if (ended) return false;
    const next = await chunks.next();
    if (next.done) { ended = true; return false; }
    buffer = String(next.value);
    hash.update(buffer);
    offset = 0;
    return true;
  }
  async function peek(): Promise<string> {
    while (await fill()) {
      while (offset < buffer.length && /\s/.test(buffer[offset])) offset++;
      if (offset < buffer.length) return buffer[offset];
    }
    return "";
  }
  async function take(char: string): Promise<void> {
    if (await peek() !== char) throw new Error(`Invalid legacy JSON: expected ${char}`);
    offset++;
  }
  async function value(): Promise<string> {
    const first = await peek();
    if (!first) throw new Error("Truncated legacy JSON");
    let depth = 0;
    let quoted = false;
    let escaped = false;
    const parts: string[] = [];
    const compound = first === "{" || first === "[";
    const string = first === '"';
    for (;;) {
      const start = offset;
      while (offset < buffer.length) {
        const char = buffer[offset];
        if (!quoted && !compound && !string && /[\s,}\]]/.test(char)) {
          parts.push(buffer.slice(start, offset));
          return parts.join("");
        }
        offset++;
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "{" || char === "[") depth++;
        else if (char === "}" || char === "]") depth--;
        if ((compound && depth === 0 && !quoted) || (string && !quoted)) {
          parts.push(buffer.slice(start, offset));
          return parts.join("");
        }
      }
      parts.push(buffer.slice(start));
      if (!await fill()) {
        if (compound || quoted) throw new Error("Truncated legacy JSON");
        return parts.join("");
      }
    }
  }
  try {
    if (await peek() === "[") {
      offset++;
      let index = 0;
      while (await peek() !== "]") {
        if (index) await take(",");
        const json = await value();
        JSON.parse(json);
        yield { key: "messages", child: String(index++), json };
      }
      offset++;
      if (await peek()) throw new Error("Trailing legacy JSON");
      return hash.digest("hex");
    }
    await take("{");
    let first = true;
    while (await peek() !== "}") {
      if (!first) await take(",");
      first = false;
      const key: string = JSON.parse(await value());
      await take(":");
      if (key === "messages" || key === "stamps" || key === "origins") {
        const array = key === "messages";
        await take(array ? "[" : "{");
        let index = 0;
        while (await peek() !== (array ? "]" : "}")) {
          if (index) await take(",");
          const child: string = array ? String(index) : JSON.parse(await value());
          if (!array) await take(":");
          const json = await value();
          JSON.parse(json);
          yield { key, child, json };
          index++;
        }
        offset++;
        yield { key, json: array ? "[]" : "{}" };
      } else {
        const json = await value();
        JSON.parse(json);
        yield { key, json };
      }
    }
    offset++;
    if (await peek()) throw new Error("Trailing legacy JSON");
    return hash.digest("hex");
  } finally {
    stream.destroy();
  }
}
