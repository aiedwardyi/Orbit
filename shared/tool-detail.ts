export interface ToolDetail {
  input?: string;
  output?: string[];
  more?: number;
  diff?: string[];
  outputHidden?: boolean;
}

interface ToolDetailInput {
  input?: string;
  output?: string;
  diff?: string[];
  outputHidden?: boolean;
  isError?: boolean;
  more?: number;
}

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
const clip = (text: string, chars: number) => Array.from(text).slice(0, chars).join("");
const shorten = (text: string) => Array.from(text).slice(0, -1).join("");

export function buildToolDetail(source: ToolDetailInput, redact: (text: string) => string): ToolDetail {
  const detail: ToolDetail = {};
  if (source.input) detail.input = clip(redact(source.input), 120);
  if (source.outputHidden) detail.outputHidden = true;
  else {
    const field = !source.isError && source.diff?.length ? "diff" : "output";
    const text = redact(field === "diff" ? source.diff!.join("\n") : source.output ?? "").replace(/\r\n?/g, "\n");
    const lines = text ? text.replace(/\n$/, "").split("\n") : [];
    const preview = lines.slice(0, source.isError ? 1 : 3).map((line) => clip(line, 80));
    if (preview.length) {
      // Reserve a character per line so a long header cannot erase the output.
      detail[field] = preview.map((line) => clip(line, 1));
      const more = (source.more ?? 0) + lines.length - preview.length;
      if (more > 0) detail.more = more;
      while (bytes(detail) > 256) detail.input = shorten(detail.input!);
      detail[field] = preview;
      while (bytes(detail) > 256) {
        const longest = preview.map((line, index) => ({ line, index }))
          .filter(({ line }) => Array.from(line).length > 1)
          .sort((a, b) => bytes(b.line) - bytes(a.line))[0];
        if (!longest) break;
        preview[longest.index] = shorten(preview[longest.index]);
      }
    }
  }
  while (bytes(detail) > 256) detail.input = shorten(detail.input!);
  return detail;
}
