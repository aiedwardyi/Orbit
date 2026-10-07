// Real markdown for bot bubbles: react-markdown + GFM (tables, task lists,
// strikethrough, autolinks) with a chromed code block — language label, copy
// button, lazy Shiki highlighting. Model output never reaches the DOM as raw
// HTML: no rehype-raw, so HTML in the text renders as text; Shiki's output is
// generator-escaped. While a message is still streaming, a code block renders
// as plain <pre> until its content has held still for STREAM_SETTLE_MS (the
// fence is very likely complete), then highlights and caches.
import { createContext, memo, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { z } from "zod";

import { useI18n } from "@/lib/i18n";

// tiny highlight cache so revisiting a thread doesn't re-tokenize settled
// blocks; keys are content-hashed and capped. Streamed partials may land here
// under their own hash — harmless (never collides with the final content's
// key, and the cap evicts it), and the final content's entry is exactly what
// makes the settled bubble render highlighted on mount.
const highlightCache = new Map<string, string>();
const CACHE_MAX = 200;
// how long a streaming block's content must be unchanged before we spend a
// tokenize on it — long enough to skip per-token churn mid-fence, short
// enough that the highlight lands before the stream settles
const STREAM_SETTLE_MS = 250;
const TALL_CODE_LINES = 15;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

// A markdown link whose target is a file on this machine: bots hand over
// bot-created documents as absolute paths or file:// URLs. Web links stay
// ordinary anchors handled by the shell's window-open policy.
// A leading slash covers macOS and Linux; "C:\…" and "C:/…" cover Windows,
// where a file:// URL's pathname also arrives as "/C:/…".
const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;
const absolutePath = (value: string): string | null => {
  if (value.startsWith("/") && WINDOWS_PATH.test(value.slice(1))) return value.slice(1);
  if (value.startsWith("/") || WINDOWS_PATH.test(value)) return value;
  return null;
};

// hrefs arrive percent-encoded, so "C:\a" reaches us as "C:%5Ca"
const decodeHref = (href: string): string => {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
};

const localFilePath = (href?: string): string | null => {
  if (!href) return null;
  // URL schemes are case-insensitive, so FILE:// is as valid as file://
  if (/^file:\/\//i.test(href)) {
    try {
      return absolutePath(decodeURIComponent(new URL(href).pathname));
    } catch {
      return null;
    }
  }
  return absolutePath(decodeHref(href));
};

// react-markdown's default transform blanks file: URLs and "C:\…" paths (an
// unknown scheme to it), and a blank href opened the app origin. Keep those
// for links only; LocalFileLink never puts them in the DOM.
const urlTransform = (url: string, key: string): string =>
  key === "href" && (/^file:/i.test(url) || WINDOWS_PATH.test(decodeHref(url))) ? url : defaultUrlTransform(url);

// A bare relative target ("reps.py", "./notes.md", "..\x.txt") means a file in
// the writing bot's folder. As an anchor it would resolve against Orbit's own
// server and open a second Orbit window. "C:foo" reads as a scheme and stays an
// anchor, like any other non-file scheme.
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
export const isRelativeHref = (href: string): boolean => !SCHEME.test(href);

// Null when there is nothing to open: no known base, a #anchor / ?query, or a
// target that climbs out of the bot's folder.
export const resolveRelativePath = (href: string, base?: string | null): string | null => {
  const root = base ? absolutePath(base) : null;
  if (!root || /^[#?]/.test(href)) return null;
  let rel = href.replace(/[#?].*$/, "");
  try {
    rel = decodeURIComponent(rel);
  } catch {
    /* keep the raw target */
  }
  const win = WINDOWS_PATH.test(root);
  const drive = win ? `${root.slice(0, 2)}\\` : "/";
  const parts = root.slice(win ? 3 : 1).split(/[\\/]+/).filter(Boolean);
  const depth = parts.length;
  for (const seg of rel.split(/[\\/]+/)) {
    if (seg === "..") {
      if (parts.length === depth) return null;
      parts.pop();
    } else if (seg && seg !== ".") parts.push(seg);
  }
  return drive + parts.join(win ? "\\" : "/");
};

const StreamingContext = createContext(false);

// Streaming replies split at blank lines that open a top-level block, so only
// the growing block re-parses per frame. HTML or a fence of unclear depth stops
// the split; a link definition keeps the reply whole.
const LIST_ITEM = /^(?:[-+*]|\d{1,9}[.)]?)(?:[ \t]|$)/;
const FENCE = /^( {0,3})(`{3,}(?=[^`]*$)|~{3,})/;

export function streamBlocks(text: string): string[] {
  if (/^ {0,3}\[[^\]\n]+\]:/m.test(text)) return [text];
  const blocks: string[] = [];
  let start = 0;
  let blank = false;
  let fence: { mark: string; indent: number } | null = null;
  for (let at = 0; at < text.length; ) {
    const end = text.indexOf("\n", at);
    const next = end === -1 ? text.length : end + 1;
    const line = text.slice(at, next);
    const indent = line.length - line.trimStart().length;
    if (fence) {
      const close = FENCE.exec(line);
      if (close && close[2][0] === fence.mark[0] && close[2].length >= fence.mark.length && !line.slice(close[0].length).trim()) {
        if (indent < fence.indent) break;
        fence = null;
      } else if (line.trim() && indent < fence.indent) break;
    } else if (!line.trim()) {
      blank = true;
    } else {
      if (blank && indent === 0 && !LIST_ITEM.test(line)) {
        blocks.push(text.slice(start, at));
        start = at;
      }
      blank = false;
      if (/^ {0,3}</.test(line)) break;
      const open = FENCE.exec(line);
      if (open) fence = { mark: open[2], indent: open[1].length };
    }
    at = next;
  }
  blocks.push(text.slice(start));
  return blocks;
}

const MarkdownBlock = memo(function MarkdownBlock({ text, components }: { text: string; components: Components }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
      {text}
    </Markdown>
  );
});

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const streaming = useContext(StreamingContext);
  const [html, setHtml] = useState<string | null>(null);
  const highlighted = useMemo(() => ({ __html: html ?? "" }), [html]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const key = `${lang}:${hash(code)}`;
    const cached = highlightCache.get(key);
    if (cached) return setHtml(cached);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const highlight = () => {
      import("shiki")
        .then((shiki) =>
          shiki.codeToHtml(code, {
            lang: lang || "text",
            theme: "github-dark-default",
          }),
        )
        .then((out) => {
          if (!alive) return;
          if (highlightCache.size >= CACHE_MAX) {
            const first = highlightCache.keys().next().value;
            if (first) highlightCache.delete(first);
          }
          highlightCache.set(key, out);
          setHtml(out);
        })
        .catch(() => {
          /* unknown language or shiki failed — the plain <pre> stays */
        });
    };
    if (streaming) {
      // any earlier highlight is of a shorter snapshot — drop it so the
      // growing plain <pre> shows the real content, then wait for the block
      // to hold still. The effect re-runs (and this cleanup clears the timer)
      // on every content change, which is the debounce.
      setHtml(null);
      timer = setTimeout(highlight, STREAM_SETTLE_MS);
    } else {
      highlight();
    }
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [code, lang, streaming]);

  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const tall = code.split("\n").length > TALL_CODE_LINES;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between border-b border-hairline/30 px-3 py-1">
        <span className="text-[11px] uppercase tracking-wide text-ink-secondary">{lang || "code"}</span>
        <button
          onClick={copy}
          className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title="Copy code"
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
        </button>
      </div>
      {html ? (
        <div
          className="overflow-x-auto text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-3"
          dangerouslySetInnerHTML={highlighted}
        />
      ) : (
        <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed text-ink">{code}</pre>
      )}
      {tall && (
        <div className="flex justify-end border-t border-hairline/30 px-3 py-1">
          <button
            onClick={copy}
            className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Copy code"
          >
            {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          </button>
        </div>
      )}
    </div>
  );
}

const PHONE_MEDIA = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  mp4: "video", webm: "video", mov: "video", m4v: "video",
  mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", aac: "audio", flac: "audio",
  pdf: "pdf",
} as const;

type PhoneExt = keyof typeof PHONE_MEDIA;
type PhoneKind = (typeof PHONE_MEDIA)[PhoneExt];

function isPhoneExt(value: string): value is PhoneExt {
  return Object.hasOwn(PHONE_MEDIA, value);
}

function phoneMediaKind(filePath: string): PhoneKind | null {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return isPhoneExt(ext) ? PHONE_MEDIA[ext] : null;
}

const missingFileSchema = z.object({ deviceId: z.string().min(1).optional() });
const deviceListSchema = z.object({
  devices: z.array(z.object({
    deviceId: z.string(),
    name: z.string().min(1),
    host: z.string().min(1),
    current: z.boolean().optional(),
  })).optional(),
});

function linkedFileSrc(threadId: string, filePath: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/linked-file?path=${encodeURIComponent(filePath)}`;
}

// A local file link renders as a button that asks the shell to open the file,
// not an anchor. An absolute path in an href resolves against the page origin
// (http://127.0.0.1:8799<path>, a second chat UI in the browser), and an
// <a href="file://…"> would still reach setWindowOpenHandler on a middle or
// modifier click. The shell decides whether to open or only reveal the file.
function DesktopFileLink({ filePath, base, children }: { filePath: string; base?: string; children?: ReactNode }) {
  const [reason, setReason] = useState("");
  // No bridge at all means a phone or browser, not an outdated desktop app.
  const desktop = Boolean(window.ogb);

  const open = async () => {
    const openFile = window.ogb?.openFile;
    if (!openFile) {
      setReason(desktop ? "Opening files needs a newer version of the desktop app" : "Files open in the desktop app");
      return;
    }
    try {
      setReason("");
      await openFile(filePath, base);
    } catch (error) {
      setReason(error instanceof Error ? error.message : "That file could not be opened");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void open()}
        title={filePath}
        className="break-words text-left text-accent underline decoration-accent/40 hover:decoration-accent"
      >
        {children}
      </button>
      {reason && <span className={`ml-1.5 text-[12px] ${desktop ? "text-danger" : "text-ink-secondary"}`}>{reason}</span>}
    </>
  );
}

function PhoneFile({
  filePath,
  threadId,
  kind,
  children,
}: {
  filePath: string;
  threadId: string;
  kind: PhoneKind;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const src = linkedFileSrc(threadId, filePath);
  const [phase, setPhase] = useState<"pending" | "local" | "remote" | "desktop">("pending");
  const [remote, setRemote] = useState<{ name: string; host: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(src, { headers: { Range: "bytes=0-0" } })
      .then(async (res) => {
        if (!alive) return;
        if (res.ok) {
          setPhase("local");
          return;
        }
        const body = missingFileSchema.safeParse(await res.json().catch(() => null));
        const deviceId = body.success ? body.data.deviceId : undefined;
        if (!deviceId) {
          setPhase("desktop");
          return;
        }
        const listed = deviceListSchema.safeParse(await fetch("/api/devices").then((response) => response.json()).catch(() => null));
        const device = listed.success
          ? listed.data.devices?.find((item) => item.deviceId === deviceId && !item.current && item.host && item.name)
          : undefined;
        if (!alive) return;
        if (!device) {
          setPhase("desktop");
          return;
        }
        setRemote({ name: device.name, host: device.host });
        setPhase("remote");
      })
      .catch(() => {
        if (alive) setPhase("desktop");
      });
    return () => {
      alive = false;
    };
  }, [src]);

  if (phase === "desktop") return <DesktopFileLink filePath={filePath}>{children}</DesktopFileLink>;
  if (phase === "remote" && remote) {
    return (
      <a
        href={`https://${remote.host}${src}`}
        data-open-on-pc={remote.name}
        className="break-words text-left text-accent underline decoration-accent/40 hover:decoration-accent"
      >
        {children}
        <span className="ml-1.5">{t("chat.openOnPc", { name: remote.name })}</span>
      </a>
    );
  }
  if (phase !== "local") {
    return (
      <button type="button" title={filePath} className="break-words text-left text-accent underline decoration-accent/40 hover:decoration-accent">
        {children}
      </button>
    );
  }
  if (kind === "image") {
    return <img src={src} alt="" data-phone-media="image" className="max-h-96 max-w-full rounded-lg border border-hairline/30" />;
  }
  if (kind === "audio") return <audio src={src} controls data-phone-media="audio" className="max-w-full" />;
  if (kind === "pdf") {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        data-phone-media="pdf"
        className="break-words text-left text-accent underline decoration-accent/40 hover:decoration-accent"
      >
        {children}
      </a>
    );
  }
  return (
    <video
      src={src}
      controls
      preload="metadata"
      playsInline
      data-phone-media="video"
      className="max-h-96 max-w-full rounded-lg border border-hairline/30"
    />
  );
}

function LocalFileLink({
  filePath,
  base,
  threadId,
  children,
}: {
  filePath: string;
  base?: string;
  threadId?: string;
  children?: ReactNode;
}) {
  const streaming = useContext(StreamingContext);
  const kind = !window.ogb && !streaming && threadId ? phoneMediaKind(filePath) : null;
  if (kind && threadId) return <PhoneFile filePath={filePath} threadId={threadId} kind={kind}>{children}</PhoneFile>;
  return <DesktopFileLink filePath={filePath} base={base}>{children}</DesktopFileLink>;
}

// Spoiler spans: GFM parses ~~text~~ to <del>; in bot messages that content
// is usually a spoiler (answers, plot points, surprises), not a deletion —
// hide it behind a tap-to-reveal chip instead of striking it through.
// Display only: the stored markdown, exports, and the model's own context
// all keep the raw ~~text~~.
function Spoiler({ children }: { children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (!revealed) {
    return (
      <span className="relative mx-px inline-block rounded px-1 py-px">
        <span
          aria-hidden="true"
          className="pointer-events-none select-none bg-raised text-transparent [&_*]:!text-transparent [&_a]:!no-underline"
        >
          {children}
        </span>
        <button
          type="button"
          aria-label="Reveal spoiler"
          title="Reveal spoiler"
          onClick={() => setRevealed(true)}
          className="absolute inset-0 rounded bg-raised/90"
        />
      </span>
    );
  }
  return (
    <span className="mx-px inline rounded px-1 py-px text-[13px] leading-relaxed text-ink underline decoration-dotted decoration-hairline underline-offset-2">
      {children}
      <button
        type="button"
        aria-label="Hide spoiler"
        title="Hide spoiler"
        onClick={() => setRevealed(false)}
        className="ml-1 rounded px-0.5 text-[11px] text-ink-secondary hover:text-ink"
      >
        Hide
      </button>
    </span>
  );
}

function ChatMarkdownComponent({
  text,
  streaming = false,
  baseDir,
  threadId,
}: {
  text: string;
  streaming?: boolean;
  baseDir?: string | null;
  threadId?: string;
}) {
  // A streamed reply keeps its blocks once settled, so settling re-parses nothing.
  const [split, setSplit] = useState(streaming);
  if (streaming && !split) setSplit(true);
  const blocks = useMemo(() => (split ? streamBlocks(text) : [text]), [split, text]);
  const components = useMemo(() => ({
    pre({ children }: { children?: ReactNode }) {
      // fenced code arrives as <pre><code class="language-x">…</code></pre>
      const child: any = Array.isArray(children) ? children[0] : children;
      const className: string = child?.props?.className ?? "";
      const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
      // children can be a string OR an array of strings/nodes - flatten
      // strings only, so String() never comma-joins an array
      const flat = (n: any): string =>
        typeof n === "string" ? n : Array.isArray(n) ? n.map(flat).join("") : (n?.props?.children ? flat(n.props.children) : "");
      const code = flat(child?.props?.children).replace(/\n$/, "");
      return <CodeBlock code={code} lang={lang} />;
    },
    img({ src, alt }: { src?: string; alt?: string }) {
      return (
        <img
          src={src}
          alt={alt ?? ""}
          loading="lazy"
          className="max-h-96 max-w-full rounded-lg border border-hairline/30"
        />
      );
    },
    code({ children }: { children?: ReactNode }) {
      return (
        <code className="rounded bg-inset px-1 py-px text-[13px]">{children}</code>
      );
    },
    a({ href, children }: { href?: string; children?: ReactNode }) {
      // a stripped target (javascript:, empty) would open the app origin
      if (!href) return <>{children}</>;
      const localPath = localFilePath(href);
      if (localPath) return <LocalFileLink filePath={localPath} threadId={threadId}>{children}</LocalFileLink>;
      if (isRelativeHref(href)) {
        const resolved = resolveRelativePath(href, baseDir);
        return resolved ? <LocalFileLink filePath={resolved} base={baseDir ?? undefined} threadId={threadId}>{children}</LocalFileLink> : <>{children}</>;
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="break-words text-accent underline decoration-accent/40 hover:decoration-accent"
        >
          {children}
        </a>
      );
    },
    table({ children }: { children?: ReactNode }) {
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13.5px]">{children}</table>
        </div>
      );
    },
    th({ children }: { children?: ReactNode }) {
      return (
        <th className="border-b border-hairline/40 px-2 py-1.5 text-left font-semibold">{children}</th>
      );
    },
    td({ children }: { children?: ReactNode }) {
      return <td className="border-b border-hairline/20 px-2 py-1.5 align-top">{children}</td>;
    },
    ul({ children }: { children?: ReactNode }) {
      return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
    },
    ol({ children }: { children?: ReactNode }) {
      return <ol className="list-decimal space-y-1 pl-5">{children}</ol>;
    },
    h1({ children }: { children?: ReactNode }) {
      return <div className="mt-2 text-[16px] font-semibold">{children}</div>;
    },
    h2({ children }: { children?: ReactNode }) {
      return <div className="mt-2 text-[15.5px] font-semibold">{children}</div>;
    },
    h3({ children }: { children?: ReactNode }) {
      return <div className="mt-1.5 font-semibold">{children}</div>;
    },
    h4({ children }: { children?: ReactNode }) {
      return <div className="mt-1.5 font-semibold">{children}</div>;
    },
    h5({ children }: { children?: ReactNode }) {
      return <div className="mt-1.5 text-[14px] font-semibold">{children}</div>;
    },
    h6({ children }: { children?: ReactNode }) {
      return <div className="mt-1.5 text-[13.5px] font-semibold text-ink-secondary">{children}</div>;
    },
    blockquote({ children }: { children?: ReactNode }) {
      return (
        <blockquote className="border-l-2 border-hairline pl-3 text-ink-secondary">{children}</blockquote>
      );
    },
    del({ children }: { children?: ReactNode }) {
      return <Spoiler>{children}</Spoiler>;
    },
    hr() {
      return <hr className="border-hairline/40" />;
    },
  }), [baseDir, threadId]);
  return (
    <StreamingContext.Provider value={streaming}>
      <div className="chat-md min-w-0 [&>*+*]:mt-2">
        {blocks.map((block, i) => (
          <MarkdownBlock key={i} text={block} components={components} />
        ))}
      </div>
    </StreamingContext.Provider>
  );
}

export const ChatMarkdown = memo(ChatMarkdownComponent);
