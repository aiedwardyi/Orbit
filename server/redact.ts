// Keeping secrets out of the native protocol log.
//
// The native tee writes every provider message verbatim, which is what makes
// protocol drift diagnosable — but the messages that set a session up carry
// the credentials the agent is handed: the box token and the comms token
// travel inside `session/new`'s mcpServers env, and a Composio consumer key
// travels in an MCP header. Those logs sit in ~/.orbit/native as
// ordinary files, are read by anyone debugging, and get pasted into issues.
//
// So the log keeps the SHAPE and loses the VALUES: a redacted entry still
// tells you a token was passed, under which name, and how long it was —
// enough to debug "the proxy got no token" without the token being there.

/** Key names whose value is a credential. Matched case-insensitively as a
 * substring, so KEY catches ANTHROPIC_API_KEY and x-api-key. */
const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];

/** `key` alone is too broad — it matches `keyboard`, `keys`, `hotkey`. Only
 * treat it as a credential when it stands alone or is a suffix, which is how
 * every real one is spelled (API_KEY, consumer-key, xai_key). */
function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
  return /(^|[_.-])keys?$/.test(lower);
}

const maskLength = (chars: number) => `«redacted ${chars} chars»`;
const mask = (value: string) => maskLength(value.length);
const REDACTION_MARKER = /^«redacted \d+ chars»$/;
const pemMask = (body: string) => {
  const trimmed = body.trim();
  return REDACTION_MARKER.test(trimmed) ? trimmed : mask(trimmed);
};

/** Walk limit, and what stands in for a subtree beyond it. */
const MAX_DEPTH = 12;
const TOO_DEEP = "«redacted: nested past the redaction depth limit»";

// ── content-shaped secrets ────────────────────────────────────────────
// What a bot's own reply, a tool title, or a permission card can carry —
// and, since the rebuild replays activity into every handed-over context,
// what would otherwise become permanent. High precision on purpose: a
// generic "long hex/base64" heuristic would rewrite real code in the
// transcript, so only shapes that are unmistakably credentials match.

const KEY_PREFIXES: RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // anthropic / openai
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // github classic
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // github fine-grained
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // slack
  /\bAKIA[0-9A-Z]{16}\b/g, // aws access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // google api key
  /\bya29\.[A-Za-z0-9._-]{16,}/g, // google oauth
  /\bnpm_[A-Za-z0-9]{20,}/g, // npm
  /\bxai-[A-Za-z0-9]{16,}/g, // xai
  /\b[sr]k_(?:live_|test_)?[A-Za-z0-9]{24,}/g, // elevenlabs / stripe
  /\bak_[A-Za-z0-9_-]{16,}/g, // composio
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // jwt
];
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
const PEM_BLOCK = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)/g;
/** The same block with its END still in flight. PEM_BLOCK cannot match it, so
 * both the stream masker and a completed full-text field hold from BEGIN
 * rather than letting a body no later chunk can match go out raw. Single-match
 * on purpose: a second unterminated BEGIN is swallowed into the first
 * placeholder's count, which loses a little shape but never a byte of key. */
const PEM_OPEN = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)(?![\s\S]*-----END [A-Z ]*PRIVATE KEY-----)([\s\S]*)$/;
/** The closing delimiter on its own, to end a block the masker is counting. */
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
/** key=value / key: value / key="value" where the key is secret-shaped.
 * The value must be a single token of some length; prose after a colon
 * ("password: leave blank…") has spaces and does not match. */
const KEY_VALUE =
  /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)(?:[_-]?key)?s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=!@#$%^*?-]{8,})\3/gi;

/** A config dump's own `key` field, both sides quoted. Bare `key` stays out of
 * KEY_VALUE: unquoted it is prose ("the primary key: customer_id"). No
 * secret-shaped name shares the burden here, hence the higher floor. */
const CONFIG_KEY_FIELD = /(["']key["']\s*:\s*)(["'])([A-Za-z0-9._~+/=-]{16,})\2/gi;

/** The same field with its closing quote still in flight. It matches nothing
 * above, so safeCut holds from where it opened rather than letting the head of
 * a value go out in pieces. */
const CONFIG_KEY_OPEN = /["']key["']\s*:\s*["'][A-Za-z0-9._~+/=-]*$/i;

/** Bound for delimiter prefixes whose regexes can grow without a terminator
 * (`-----BEGIN [A-Z ]*…`). Ordinary text uses secretPrefixStart instead. */
const STREAM_HOLD = 96;

/** Enough of an open block's tail to still match an END split across chunks. */
const PEM_TAIL_HOLD = 96;

const STREAM_MATCHERS: RegExp[] = [PEM_BLOCK, ...KEY_PREFIXES, BEARER, KEY_VALUE, CONFIG_KEY_FIELD];

const WORD_CHAR = /[A-Za-z0-9_]/;
const JWT_SEG_CHAR = /[A-Za-z0-9_-]/;
const BEARER_TOKEN_CHAR = /[A-Za-z0-9._~+/=-]/;
const KV_VALUE_CHAR = /[A-Za-z0-9._~+/=!@#$%^*?-]/;
const CONFIG_VALUE_CHAR = /[A-Za-z0-9._~+/=-]/;
const SECRET_KEY_NAME =
  /^(?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)(?:[_-]?key)?s?$/i;
const SECRET_NAME_STEMS = [
  "apikey", "api_key", "api-key", "secret", "token", "password", "passwd",
  "authorization", "authtoken", "auth_token", "auth-token",
  "accesskey", "access_key", "access-key",
  "privatekey", "private_key", "private-key",
];
const SECRET_NAME_SUFFIXES = ["", "s", "key", "_key", "-key", "keys", "_keys", "-keys"];

const KEY_STARTERS: Array<readonly [string, RegExp]> = [
  ["sk-ant-", /[A-Za-z0-9_-]/],
  ["sk-proj-", /[A-Za-z0-9_-]/],
  ["sk-live-", /[A-Za-z0-9_-]/],
  ["sk-test-", /[A-Za-z0-9_-]/],
  ["sk-", /[A-Za-z0-9_-]/],
  ["github_pat_", /[A-Za-z0-9_]/],
  ["ghp_", /[A-Za-z0-9]/],
  ["gho_", /[A-Za-z0-9]/],
  ["ghu_", /[A-Za-z0-9]/],
  ["ghs_", /[A-Za-z0-9]/],
  ["ghr_", /[A-Za-z0-9]/],
  ["xoxa-", /[A-Za-z0-9-]/],
  ["xoxb-", /[A-Za-z0-9-]/],
  ["xoxp-", /[A-Za-z0-9-]/],
  ["xoxo-", /[A-Za-z0-9-]/],
  ["xoxs-", /[A-Za-z0-9-]/],
  ["xoxr-", /[A-Za-z0-9-]/],
  ["AKIA", /[0-9A-Z]/],
  ["AIza", /[0-9A-Za-z_-]/],
  ["ya29.", /[A-Za-z0-9._-]/],
  ["npm_", /[A-Za-z0-9]/],
  ["xai-", /[A-Za-z0-9]/],
  ["sk_live_", /[A-Za-z0-9]/],
  ["sk_test_", /[A-Za-z0-9]/],
  ["rk_live_", /[A-Za-z0-9]/],
  ["rk_test_", /[A-Za-z0-9]/],
  ["sk_", /[A-Za-z0-9]/],
  ["rk_", /[A-Za-z0-9]/],
  ["ak_", /[A-Za-z0-9_-]/],
];

function atWordBoundary(text: string, i: number): boolean {
  const prev = i === 0 ? "" : text[i - 1]!;
  const curr = text[i] ?? "";
  return WORD_CHAR.test(prev) !== WORD_CHAR.test(curr);
}

function charsetRun(s: string, re: RegExp): boolean {
  for (const c of s) {
    if (!re.test(c)) return false;
  }
  return true;
}

function couldBeJwt(s: string): boolean {
  if ("eyJ".startsWith(s)) return true;
  if (!s.startsWith("eyJ")) return false;
  let segs = 1;
  let n = 0;
  for (let i = 3; i < s.length; i++) {
    const c = s[i]!;
    if (c === ".") {
      if (n < 8 || segs >= 3) return false;
      segs += 1;
      n = 0;
      continue;
    }
    if (!JWT_SEG_CHAR.test(c)) return false;
    n += 1;
  }
  return true;
}

function couldBeKeyPrefix(s: string): boolean {
  if (couldBeJwt(s)) return true;
  for (const [starter, charset] of KEY_STARTERS) {
    if (starter.startsWith(s)) return true;
    if (s.startsWith(starter) && charsetRun(s.slice(starter.length), charset)) return true;
  }
  return false;
}

function couldBeBearer(s: string): boolean {
  if (/^b(e(a(r(e(r)?)?)?)?)?$/i.test(s)) return true;
  const m = /^(Bearer)(\s+)(.*)$/i.exec(s);
  if (!m) return false;
  return charsetRun(m[3]!, BEARER_TOKEN_CHAR);
}

function couldBePemBegin(s: string): boolean {
  if (s.length === 0 || s.length > STREAM_HOLD) return false;
  if (/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) return false;
  if (/^-{1,5}$/.test(s)) return true;
  if (/^-----B(E(G(I(N)?)?)?)?$/.test(s)) return true;
  if (/^-----BEGIN [A-Z ]*$/.test(s)) return true;
  return /^-----BEGIN [A-Z ]*P(R(I(V(A(T(E( (K(E(Y-{0,5})?)?)?)?)?)?)?)?)?)?$/.test(s);
}

function couldBeConfigKey(s: string): boolean {
  if (s[0] !== '"' && s[0] !== "'") return false;
  const rest = s.slice(1);
  if (rest.length === 0) return true;
  if (/^k(e(y)?)?$/i.test(rest)) return true;
  if (!/^key/i.test(rest)) return false;
  let i = 3;
  if (i >= rest.length) return true;
  // CONFIG_KEY_FIELD / CONFIG_KEY_OPEN use ["']key["'] — the two name quotes
  // are independent, so "key' and 'key" are still field prefixes.
  if (rest[i] !== '"' && rest[i] !== "'") return false;
  i += 1;
  while (i < rest.length && /\s/.test(rest[i]!)) i += 1;
  if (i >= rest.length) return true;
  if (rest[i] !== ":") return false;
  i += 1;
  while (i < rest.length && /\s/.test(rest[i]!)) i += 1;
  if (i >= rest.length) return true;
  const q2 = rest[i]!;
  if (q2 !== '"' && q2 !== "'") return false;
  i += 1;
  while (i < rest.length && CONFIG_VALUE_CHAR.test(rest[i]!)) i += 1;
  if (i >= rest.length) return true;
  return false;
}

function couldBecomeSecretKeyName(id: string): boolean {
  if (SECRET_KEY_NAME.test(id)) return true;
  if (id.endsWith("_") || id.endsWith("-")) return true;
  const lower = id.toLowerCase();
  for (const stem of SECRET_NAME_STEMS) {
    for (const suffix of SECRET_NAME_SUFFIXES) {
      const name = stem + suffix;
      if (name.startsWith(lower)) return true;
      for (let i = 1; i < lower.length; i++) {
        const prev = lower[i - 1];
        if ((prev === "_" || prev === "-") && name.startsWith(lower.slice(i))) return true;
      }
    }
  }
  return false;
}

function couldBeKeyValue(s: string): boolean {
  if (!/^[A-Za-z0-9_-]/.test(s)) return false;
  let i = 0;
  while (i < s.length && /[A-Za-z0-9_-]/.test(s[i]!)) i += 1;
  const id = s.slice(0, i);
  if (i >= s.length) return couldBecomeSecretKeyName(id);
  if (!SECRET_KEY_NAME.test(id)) return false;
  if (s[i] === '"' || s[i] === "'") i += 1;
  if (i >= s.length) return true;
  while (i < s.length && /\s/.test(s[i]!)) i += 1;
  if (i >= s.length) return true;
  if (s[i] !== "=" && s[i] !== ":") return false;
  i += 1;
  while (i < s.length && /\s/.test(s[i]!)) i += 1;
  if (i >= s.length) return true;
  if (s[i] === '"' || s[i] === "'") i += 1;
  if (i >= s.length) return true;
  while (i < s.length && KV_VALUE_CHAR.test(s[i]!)) i += 1;
  return i >= s.length;
}

/** Leftmost index of a suffix that could still complete into a secret match. */
function secretPrefixStart(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const suffix = text.slice(i);
    if (couldBePemBegin(suffix) || couldBeConfigKey(suffix)) return i;
    if (!atWordBoundary(text, i)) continue;
    if (couldBeKeyPrefix(suffix) || couldBeBearer(suffix) || couldBeKeyValue(suffix)) return i;
  }
  return text.length;
}

/** How much of the buffer may be masked and emitted now. A match reaching the
 * unsettled tail can still grow, and masking it strands the rest of the secret
 * in a later chunk with no prefix left to match — so it stays whole in the hold
 * until a non-matching character or flush() ends it. */
function safeCut(text: string): number {
  let cut = secretPrefixStart(text);
  const spans = STREAM_MATCHERS.flatMap((re) =>
    [...text.matchAll(re)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const),
  );
  const open = CONFIG_KEY_OPEN.exec(text);
  if (open) spans.push([open.index, text.length] as const);
  const openPem = PEM_OPEN.exec(text);
  if (openPem) spans.push([openPem.index, text.length] as const);
  // Regexes from different families can overlap, so one shift can expose another.
  // A match that reaches EOS can still grow; treat that as overlapping the cut.
  for (let moved = true; moved; ) {
    moved = false;
    for (const [start, end] of spans) {
      // end === text.length: match ends at EOS and could still grow in the next chunk.
      if (start < cut && (end > cut || end === text.length)) {
        cut = start;
        moved = true;
      }
    }
  }
  return cut;
}

/** A held tail belongs to the turn that opened it. Claude emits item.updated
 * mid-stream, so tearing the maskers down on every non-delta event strands an
 * open block: the prefix flushes, the state goes, and the rest of the body
 * reaches a fresh masker with no BEGIN left to match. */
const STREAM_BOUNDARIES = new Set(["turn.completed", "turn.retrying", "session.exited"]);
export const endsContentStream = (type: string | undefined): boolean => !!type && STREAM_BOUNDARIES.has(type);

/** Length of a body after trim(), accumulated over chunks nobody keeps. */
class TrimmedLength {
  private started = false;
  private pending = 0;
  value = 0;

  add(text: string) {
    const first = text.search(/\S/);
    if (first < 0) {
      if (this.started) this.pending += text.length;
      return;
    }
    const trailing = text.search(/\s*$/);
    this.value += this.pending + (this.started ? first : 0) + (trailing - first);
    this.pending = text.length - trailing;
    this.started = true;
  }
}

/** Hold a raw suffix across SSE / NDJSON chunks so `sk-ant` + `-api03-…`
 * still redacts. Emits only the safe prefix; call flush() at stream end.
 *
 * A PEM body is the one secret longer than any hold, so once a block opens the
 * masker stops buffering it and starts COUNTING: it is going to be masked
 * whatever arrives, and holding it would buffer the rest of the response and
 * rescan all of it on every chunk. */
export class StreamSecretMasker {
  private hold = "";
  private pem: { open: string; body: TrimmedLength; tail: string } | null = null;
  /** Last emitted character — virtual lead so the next chunk sees the same \b context as a contiguous buffer. */
  private prevChar: string | null = null;

  push(chunk: string): string {
    if (this.pem) return this.pushOpenPem(chunk);
    const lead = this.prevChar ?? "";
    const offset = lead.length;
    const buffered = this.hold + chunk;
    const cutWin = safeCut(lead + buffered);
    const cut = Math.max(0, cutWin - offset);
    this.hold = buffered.slice(cut);
    let out = "";
    if (cut > 0) {
      const redacted = redactSecretsInText(lead + buffered.slice(0, cut));
      out = offset === 0 ? redacted : redacted.slice(offset);
      this.prevChar = buffered[cut - 1]!;
    }
    return out + this.startOpenPem();
  }

  flush(): string {
    if (this.pem) {
      const out = this.closeOpenPem(this.pem.tail, "");
      this.hold = "";
      this.prevChar = null;
      return out;
    }
    const lead = this.prevChar ?? "";
    const redacted = redactSecretsInText(lead + this.hold);
    const out = lead ? redacted.slice(lead.length) : redacted;
    this.hold = "";
    this.prevChar = null;
    return out;
  }

  /** Stop holding an unterminated block once its body outgrows the tail we
   * need to still match an END delimiter split across chunks. */
  private startOpenPem(): string {
    const open = PEM_OPEN.exec(this.hold);
    if (!open || open[2].length <= PEM_TAIL_HOLD) return "";
    const head = this.hold.slice(0, open.index);
    this.hold = "";
    this.pem = { open: open[1], body: new TrimmedLength(), tail: "" };
    this.countBody(open[2]);
    if (!head) return "";
    const lead = this.prevChar ?? "";
    const redacted = redactSecretsInText(lead + head);
    const out = lead ? redacted.slice(lead.length) : redacted;
    this.prevChar = head[head.length - 1]!;
    return out;
  }

  private pushOpenPem(chunk: string): string {
    const buffered = this.pem!.tail + chunk;
    const end = PEM_END.exec(buffered);
    if (!end) {
      this.countBody(buffered);
      return "";
    }
    // Whatever follows the closing delimiter is ordinary text again.
    const closed = this.closeOpenPem(buffered.slice(0, end.index), `\n${end[0]}`);
    this.prevChar = end[0][end[0].length - 1]!;
    return closed + this.push(buffered.slice(end.index + end[0].length));
  }

  private countBody(text: string) {
    const pem = this.pem!;
    const drop = Math.max(0, text.length - PEM_TAIL_HOLD);
    pem.body.add(text.slice(0, drop));
    pem.tail = text.slice(drop);
  }

  private closeOpenPem(body: string, close: string): string {
    const pem = this.pem!;
    pem.body.add(body);
    this.pem = null;
    return `${pem.open}\n${maskLength(pem.body.value)}${close}`;
  }
}


export function redactSecretsInText(text: string): string {
  if (!text || text.length < 8) return text;
  let out = text;
  out = out.replace(PEM_BLOCK, (_m, open: string, body: string, close: string) => `${open}\n${pemMask(body)}\n${close}`);
  out = out.replace(PEM_OPEN, (_m, open: string, body: string) => {
    const trimmed = body.trim();
    return trimmed ? `${open}\n${pemMask(body)}` : open;
  });
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  out = out.replace(BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`);
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  out = out.replace(CONFIG_KEY_FIELD, (_m, lead: string, quote: string, value: string) => `${lead}${quote}${mask(value)}${quote}`);
  return out;
}

/** Deep copy with credential VALUES replaced. Handles the two shapes that
 * actually carry them: a plain object of env vars ({KEY: "v"}) and the ACP
 * wire shape (env: [{name, value}]). Anything unrecognised is copied as-is. */
export function redactSecrets(input: unknown, depth = 0): unknown {
  if (typeof input === "string") return redactSecretsInText(input);
  if (input === null || typeof input !== "object") return input;
  // Past the cap the subtree is not walked, so it must not be COPIED either —
  // returning it whole hands back every credential nested below the limit.
  if (depth > MAX_DEPTH) return TOO_DEEP;

  if (Array.isArray(input)) {
    return input.map((item) => {
      // ACP env entries: {name: "OMB_COMMS_TOKEN", value: "…"}
      if (
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as { name?: unknown }).name === "string" &&
        typeof (item as { value?: unknown }).value === "string"
      ) {
        const entry = item as { name: string; value: string };
        // Every other field rides the ordinary object pass — spreading
        // `item` here copied a sibling credential out untouched.
        const scrubbed = redactSecrets(item, depth + 1);
        if (scrubbed === null || typeof scrubbed !== "object") return scrubbed;
        // SAFETY: `item` is a non-array object, so the object branch above
        // returned the record it built — the depth marker is a string, and
        // the guard on the line above already returned it.
        const out = scrubbed as Record<string, unknown>;
        // `name` goes back raw: the shape is what makes a redacted log debuggable.
        out.name = entry.name;
        // A non-secret-shaped name (a custom env var, a feature flag) does
        // not clear the value of suspicion — the same content pass every
        // other string in this tree gets is what catches a credential
        // someone stashed under an ordinary-looking name.
        out.value = isSecretName(entry.name) ? mask(entry.value) : redactSecretsInText(entry.value);
        return out;
      }
      return redactSecrets(item, depth + 1);
    });
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && isSecretName(key)) {
      out[key] = mask(value);
      continue;
    }
    // any other string may still CONTAIN a credential (a command line, a
    // header value, a bot's reply) — the content pass catches those
    out[key] = redactSecrets(value, depth + 1);
  }
  return out;
}
