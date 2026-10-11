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
      if (lines.length > preview.length) detail.more = lines.length - preview.length;
      while (bytes(detail) > 256) detail.input = shorten(detail.input!);
      detail[field] = preview;
      while (bytes(detail) > 256) {
        const index = preview.map((line, index) => ({ line, index }))
          .filter(({ line }) => Array.from(line).length > 1)
          .sort((a, b) => bytes(b.line) - bytes(a.line))[0]!.index;
        preview[index] = shorten(preview[index]);
      }
    }
  }
  while (bytes(detail) > 256) detail.input = shorten(detail.input!);
  return detail;
}
