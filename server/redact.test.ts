// The native log must keep the shape of a session-setup message and lose the
// credential values. These tests use the exact shapes the drivers actually
// write — the ACP `env: [{name,value}]` wire form and the claude mcpServers
// object form — so a change to either shape breaks the test, not the secret.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { redactSecrets, StreamSecretMasker } from "./redact.ts";

const flat = (value: unknown) => JSON.stringify(value);

const PEM_LINE = "AbCd0123+/".repeat(10);
const PEM_BODY = Array(8).fill(PEM_LINE).join("\n");
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`;

const chunksOf = (text: string, size: number) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, i * size + size));

function streamed(text: string, size: number): string {
  const masker = new StreamSecretMasker();
  let out = "";
  for (const chunk of chunksOf(text, size)) out += masker.push(chunk);
  return out + masker.flush();
}

describe("redactSecrets", () => {
  it("masks the tokens in an ACP session/new, keeping the shape", () => {
    const sessionNew = {
      jsonrpc: "2.0",
      id: 3,
      method: "session/new",
      params: {
        cwd: "/Users/someone",
        mcpServers: [
          {
            name: "agents",
            command: "/usr/bin/node",
            args: ["/app/agents-proxy.js"],
            env: [
              { name: "OMB_BOT_ID", value: "bot-123" },
              { name: "OMB_COMMS_TOKEN", value: "s3cret-comms-token-value" },
            ],
          },
          {
            name: "computer",
            command: "/usr/bin/node",
            args: ["/app/computer-proxy.js"],
            env: [
              { name: "OGB_BOX_ID", value: "box-9" },
              { name: "OGB_BOX_TOKEN", value: "box_live_abcdefghijklmnop" },
            ],
          },
        ],
      },
    };

    const out = flat(redactSecrets(sessionNew));

    expect(out).not.toContain("s3cret-comms-token-value");
    expect(out).not.toContain("box_live_abcdefghijklmnop");
    // shape survives: still the same method, servers, names and non-secret env
    expect(out).toContain("session/new");
    expect(out).toContain("OMB_COMMS_TOKEN");
    expect(out).toContain("OGB_BOX_TOKEN");
    expect(out).toContain("bot-123");
    expect(out).toContain("box-9");
    expect(out).toContain("/app/agents-proxy.js");
    // and it says how long the value was, which is what you debug with
    expect(out).toContain("«redacted 24 chars»");
  });

  it("masks a Composio key in an MCP header and an env object", () => {
    // `x-api-key` is itself secret-shaped, so the header alone passes on the
    // NAME and would hide a missing ak_ prefix. The same key also rides an
    // ordinary field, where only its shape can save it.
    const composioKey = "ak_live_supersecret";
    const config = {
      mcpServers: {
        composio: {
          type: "http",
          url: "https://app.composio.dev/tool_router/v3/trs_test/mcp",
          headers: { "x-api-key": composioKey },
          lastError: `tool_router rejected ${composioKey}`,
        },
        computer: { env: { ELECTRON_RUN_AS_NODE: "1", OGB_BOX_TOKEN: "box_live_zzz" } },
      },
    };

    const out = flat(redactSecrets(config));
    expect(out).not.toContain(composioKey);
    expect(out).not.toContain("box_live_zzz");
    expect(out).toContain("app.composio.dev");
    expect(out).toContain("ELECTRON_RUN_AS_NODE");
    expect(out).toContain('"1"'); // a non-secret value is untouched
  });

  it("still content-redacts an ACP env entry whose name is not secret-shaped", () => {
    // A credential can land under an ordinary-looking variable name (a
    // custom env var, a feature flag someone repurposed) — the ACP
    // {name,value} shortcut must not skip the content pass just because
    // the NAME alone doesn't scream "secret".
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const leaked = `sk-ant-api03-${alpha}`;
    const sessionNew = {
      params: {
        mcpServers: [
          {
            name: "custom",
            env: [
              { name: "SESSION_CONFIG", value: leaked },
              { name: "FEATURE_FLAG", value: "enabled" },
            ],
          },
        ],
      },
    };

    const out = flat(redactSecrets(sessionNew));
    expect(out).not.toContain(leaked);
    expect(out).toContain("SESSION_CONFIG");
    expect(out).toContain("FEATURE_FLAG");
    expect(out).toContain("enabled");
    expect(out).toMatch(/«redacted \d+ chars»/);
  });

  it("scrubs an ACP env entry's OTHER fields, not just its value", () => {
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const leaked = `sk-ant-api03-${alpha}`;
    const out = flat(redactSecrets([{ name: "OMB_BOT_ID", value: "bot-1", note: `rotated from ${leaked}` }]));
    expect(out).not.toContain(leaked);
    expect(out).toContain("OMB_BOT_ID");
    expect(out).toContain("bot-1");
  });

  it("does not hand back a subtree nested past the depth limit", () => {
    let deep: Record<string, unknown> = { token: "deep-secret-value" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(flat(redactSecrets(deep))).not.toContain("deep-secret-value");
  });

  it("leaves ordinary protocol traffic alone", () => {
    const update = {
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "the key to this bug" } } },
    };
    expect(redactSecrets(update)).toEqual(update);
  });

  it("does not mangle words that merely contain 'key'", () => {
    const msg = { keyboard: "cmd+k", monkey: "business", keys: "SECRET-LIST", hotkey: "ctrl" };
    const out = redactSecrets(msg) as Record<string, string>;
    expect(out.keyboard).toBe("cmd+k");
    expect(out.monkey).toBe("business");
    expect(out.hotkey).toBe("ctrl");
    // `keys` standing alone IS treated as a credential holder
    expect(out.keys).toContain("redacted");
  });

  it("survives cycles-adjacent depth and non-objects", () => {
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(42)).toBe(42);
    let deep: Record<string, unknown> = { token: "deep-secret" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(() => redactSecrets(deep)).not.toThrow();
  });
});

import { endsContentStream, redactSecretsInText } from "./redact.ts";

// Content-shaped secrets: what a bot's own reply, a tool title, or a
// permission card can carry. High precision on purpose — a false positive
// here rewrites real code in the transcript.
describe("redactSecretsInText", () => {
  it("masks known key prefixes wherever they appear", () => {
    // fixtures are assembled at runtime so no token-shaped literal sits in
    // the source — GitHub's push protection (rightly) flags those
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const cases: Array<[string, RegExp]> = [
      [`set ANTHROPIC_API_KEY=sk-ant-api03-${alpha}`, /sk-ant/],
      [`OpenAI: sk-proj-${alpha}ABCD`, /sk-proj/],
      [`gh token ${"gh" + "p_"}${alpha}`, /ghp_/],
      [`fine-grained ${"github_" + "pat_"}11ABCDEFG0${alpha}`, /github_pat_/],
      [`slack ${"xox" + "b-"}${"123456789012"}-${"1234567890123"}-${alpha.slice(0, 24)}`, /xoxb-/],
      [`aws ${"AKIA" + "IOSFODNN7EXAMPLE"} and more`, /IOSFODNN7EXAMPLE/],
      [`google ${"AIza" + "SyA-"}${alpha.slice(0, 32)}`, /AIza/],
      [`npm ${"npm" + "_"}${alpha}`, /npm_[a-z]/],
      // sk_live_/sk_test_ break on the underscore, so a plain [A-Za-z0-9] run misses them
      [`stripe ${"sk" + "_"}live_51H${alpha.slice(0, 30)}`, /sk_live_/],
      [`stripe ${"sk" + "_"}test_4eC39HqLyjWDarjtT1zdp7dc`, /sk_test_/],
      [`stripe restricted ${"rk" + "_"}live_51H${alpha.slice(0, 30)}`, /rk_live_/],
    ];
    for (const [input, leak] of cases) {
      const out = redactSecretsInText(input);
      expect(out, input).not.toMatch(leak);
      expect(out).toMatch(/«redacted \d+ chars»/);
    }
  });

  it("masks a bare Google OAuth token in prose", () => {
    const token = `${"ya29" + "."}abcdefghijklmnop_0123456789-ABCD`;
    expect(redactSecretsInText(`received ${token} from upstream`)).toBe(`received «redacted ${token.length} chars» from upstream`);
  });

  it("masks lowercase bearer tokens in prose", () => {
    const token = "abcdefghijklmnop_0123456789";
    expect(redactSecretsInText(`sent bearer ${token} upstream`)).toBe(`sent bearer «redacted ${token.length} chars» upstream`);
  });

  it("masks an entire unquoted password containing punctuation", () => {
    const password = "abcdefgh!@suffix";
    const out = redactSecretsInText(`password=${password} next`);
    expect(out).not.toContain("!@suffix");
    expect(out).toBe(`password=«redacted ${password.length} chars» next`);
  });

  it.each([",", ";", "&"])("preserves the field after a %s password separator", (separator) => {
    const password = "abc!@#123";
    const out = redactSecretsInText(`password=${password}${separator}username=admin`);
    expect(out).not.toContain(password);
    expect(out).toContain("username=admin");
    expect(out).toBe(`password=«redacted ${password.length} chars»${separator}username=admin`);
  });

  it("redacts a password value that runs up to a comma separator", () => {
    const password = "abcdefgh!@suffix";
    const out = redactSecretsInText(`password=${password},other=val`);
    expect(out).not.toContain("!@suffix");
    expect(out).toBe(`password=«redacted ${password.length} chars»,other=val`);
  });

  it("masks each supported password punctuation character without leaving a suffix", () => {
    for (const punctuation of "!@#$%^*?") {
      const password = `abcdefgh${punctuation}suffix`;
      expect(redactSecretsInText(`password=${password}`)).toBe(`password=«redacted ${password.length} chars»`);
    }
  });

  it("leaves password instructions containing spaces unchanged", () => {
    const text = "password: leave blank for now";
    expect(redactSecretsInText(text)).toBe(text);
  });

  it("does not remask a PEM body that is already a redaction marker", () => {
    const once = redactSecretsInText(PEM);
    expect(once).toBe(`-----BEGIN PRIVATE KEY-----\n«redacted ${PEM_BODY.length} chars»\n-----END PRIVATE KEY-----`);
    expect(redactSecretsInText(once)).toBe(once);
  });

  it("masks JWTs, PEM private key blocks, and bearer tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactSecretsInText(`token ${jwt} ok`)).toBe(`token «redacted ${jwt.length} chars» ok`);
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";
    const out = redactSecretsInText(`here:\n${pem}\ndone`);
    expect(out).not.toContain("b3BlbnNzaC1r");
    expect(out).toMatch(/BEGIN OPENSSH PRIVATE KEY[\s\S]*«redacted \d+ chars»[\s\S]*END OPENSSH PRIVATE KEY/);
    expect(redactSecretsInText('curl -H "Authorization: Bearer abc.def-ghi_jkl123456789"')).toBe('curl -H "Authorization: Bearer «redacted 24 chars»"');
  });

  it("masks the value of a secret-shaped key=value or key: value, keeping the key", () => {
    expect(redactSecretsInText("export DATABASE_PASSWORD=hunter2hunter2")).toBe("export DATABASE_PASSWORD=«redacted 14 chars»");
    expect(redactSecretsInText('{"api_key": "abcd1234efgh5678"}')).toBe('{"api_key": "«redacted 16 chars»"}');
    expect(redactSecretsInText("client_secret: 'zzzz-yyyy-xxxx-1'")).toBe("client_secret: '«redacted 16 chars»'");
    expect(redactSecretsInText("--token=abc123def456")).toBe("--token=«redacted 12 chars»");
    // the stem is secret-shaped, so a `_key` suffix on it must not shake the match
    expect(redactSecretsInText("secret_key=abcdef123456789")).toBe("secret_key=«redacted 15 chars»");
    expect(redactSecretsInText("client_secret_key=abcdef123456789")).toBe("client_secret_key=«redacted 15 chars»");
    expect(redactSecretsInText("SECRET_KEY = 'abcdef123456789'")).toBe("SECRET_KEY = '«redacted 15 chars»'");
  });

  it("leaves no live key in a ~/.orbit/config.json dump", () => {
    // one credential per friends engine plus the two integrations, assembled
    // at runtime so no token-shaped literal sits in the source
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const keys = {
      grok: `${"xai" + "-"}${alpha}${alpha}`,
      claude: `${"sk-" + "ant-"}api03-${alpha}`,
      codex: `${"sk-" + "proj-"}${alpha}`,
      antigravity: `${"AIza" + "Sy"}${alpha.slice(0, 33)}`,
      composio: `${"ak" + "_"}${alpha.slice(0, 26)}`,
      elevenlabs: `${"sk" + "_"}${"0123456789abcdef".repeat(3)}`,
    };
    const dump = JSON.stringify(
      {
        xai: { key: keys.grok },
        gemini: { apiKey: keys.antigravity },
        openaiCompat: { key: keys.codex },
        composio: { apiKey: keys.composio, userId: "local" },
        tts: { key: keys.elevenlabs, provider: "elevenlabs" },
        instances: { claudeAgent: { driver: "claudeAgent", environment: { ANTHROPIC_API_KEY: keys.claude } } },
        profile: { name: "Sam", email: "sam@example.test" },
      },
      null,
      2,
    );

    const out = redactSecretsInText(dump);
    for (const [engine, key] of Object.entries(keys)) {
      expect(out, engine).not.toContain(key);
      // and no usable head of one survives the mask either
      expect(out, engine).not.toContain(key.slice(0, 20));
    }
    // the shape a reader debugs with is still there
    expect(out).toContain("ANTHROPIC_API_KEY");
    expect(out).toContain('"provider": "elevenlabs"');
    expect(out).toContain('"userId": "local"');
    expect(out).toContain("sam@example.test");
  });

  it("masks an opaque value under a quoted config `key` field, and leaves `key` prose alone", () => {
    // no known prefix saves this one — the quoted field shape is all there is
    expect(redactSecretsInText(`"key": "${"fw" + "_"}3a9c1e7b4d5a6f8e9c0b1a2d"`)).toBe(`"key": "«redacted 27 chars»"`);
    // …and bare `key` in prose is not a credential, whatever follows it
    for (const s of [
      "the primary key: customer_id",
      "redis key: session_token_ttl",
      "map key: someIdentifier",
      'the JSON field "key": "documentation"',
    ]) expect(redactSecretsInText(s), s).toBe(s);
  });

  it("leaves ordinary text, code, hashes and URLs alone", () => {
    for (const s of [
      "the keyboard shortcut is cmd-k",
      "git commit 3f2a9c1e7b4d5a6f8e9c0b1a2d3e4f5a6b7c8d9e",
      "https://example.com/path?page=2&sort=asc",
      "const token = await getToken(); // fetches later",
      "password: (leave blank to keep the current one)",
      "Bearer tokens are sent in the Authorization header",
      "sk-8", // too short to be a key
    ]) {
      expect(redactSecretsInText(s), s).toBe(s);
    }
  });

  it("wires stream-aware masking onto SSE frames and persisted NDJSON", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(readFileSync(join(here, "index.ts"), "utf8")).toContain("StreamSecretMasker");
    expect(readFileSync(join(here, "harness/bus.ts"), "utf8")).toContain("StreamSecretMasker");
  });

  it("masks a key split across stream chunks using a bounded hold", () => {
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const key = `sk-ant-api03-${alpha}`;
    const masker = new StreamSecretMasker();
    const first = masker.push(`hello ${key.slice(0, 6)}`);
    expect(first).not.toContain("sk-ant");
    const rest = masker.push(`${key.slice(6)} done`);
    expect(rest).not.toContain("sk-ant");
    const flushed = first + rest + masker.flush();
    expect(flushed).not.toContain(key);
    expect(flushed).not.toMatch(/sk-ant/);
    expect(flushed).toMatch(/hello «redacted \d+ chars» done/);
  });

  it("keeps masking a key that keeps growing past the chunk that first matched it", () => {
    const masker = new StreamSecretMasker();
    const tail = "B".repeat(20);
    const out =
      masker.push("sk-ant-") + masker.push("A".repeat(16)) + masker.push(tail) + masker.flush();
    expect(out).not.toContain(tail);
    expect(out).not.toMatch(/sk-ant/);
    expect(out).toMatch(/^«redacted \d+ chars»$/);
  });

  it("holds a key that starts beyond the bounded window until the stream ends", () => {
    const masker = new StreamSecretMasker();
    const tail = "B".repeat(20);
    const emitted =
      masker.push(`${"prose ".repeat(40)}sk-ant-${"A".repeat(100)}`) + masker.push(tail);
    const out = emitted + masker.flush();
    expect(emitted).not.toMatch(/sk-ant/);
    expect(out).not.toContain(tail);
    expect(out).not.toMatch(/sk-ant/);
    expect(out).toMatch(/prose «redacted 127 chars»$/);
  });

  it("holds a quoted config `key` whose closing quote is still in flight", () => {
    // longer than STREAM_HOLD and with no known prefix, so only the open-field
    // hold stops the head of it being emitted before the value completes
    const opaque = `${"fw" + "_"}${"3a9c1e7b4d5a6f8e".repeat(8)}`;
    const masker = new StreamSecretMasker();
    const emitted = masker.push(`{"key": "${opaque}`);
    const out = emitted + masker.push('"}') + masker.flush();
    expect(emitted).not.toContain(opaque.slice(0, 40));
    expect(out).not.toContain(opaque.slice(0, 40));
    expect(out).toBe(`{"key": "«redacted ${opaque.length} chars»"}`);
  });

  it("masks a PEM block that only completes many chunks later", () => {
    const out = streamed(PEM, 40);
    expect(out).not.toContain(PEM_LINE);
    expect(out).toBe(`-----BEGIN PRIVATE KEY-----\n«redacted ${PEM_BODY.length} chars»\n-----END PRIVATE KEY-----`);
  });

  it("masks a PEM block whose BEGIN delimiter is split across chunks", () => {
    const masker = new StreamSecretMasker();
    const emitted = masker.push("here it is:\n-----BEGIN PRI") + masker.push(`VATE KEY-----\n${PEM_BODY}`);
    const out = emitted + masker.push("\n-----END PRIVATE KEY-----\ndone") + masker.flush();
    expect(emitted).not.toContain(PEM_LINE);
    expect(out).not.toContain(PEM_LINE);
    expect(out).toBe(`here it is:\n-----BEGIN PRIVATE KEY-----\n«redacted ${PEM_BODY.length} chars»\n-----END PRIVATE KEY-----\ndone`);
  });

  it("masks the body of a block whose END never arrives", () => {
    const masker = new StreamSecretMasker();
    const emitted = masker.push(`-----BEGIN PRIVATE KEY-----\n${PEM_BODY}`);
    const out = emitted + masker.flush();
    expect(emitted).toBe("");
    expect(out).toBe(`-----BEGIN PRIVATE KEY-----\n«redacted ${PEM_BODY.length} chars»`);
  });

  it("masks a PEM block streamed one character at a time", () => {
    const out = streamed(PEM, 1);
    expect(out).not.toContain(PEM_LINE);
    expect(out).toBe(`-----BEGIN PRIVATE KEY-----\n«redacted ${PEM_BODY.length} chars»\n-----END PRIVATE KEY-----`);
  });

  it("masks an unterminated block in a completed full-text field", () => {
    const out = redactSecretsInText(`-----BEGIN PRIVATE KEY-----\n${PEM_BODY}`);
    expect(out).not.toContain(PEM_LINE);
    expect(out).toBe(`-----BEGIN PRIVATE KEY-----\n«redacted ${PEM_BODY.length} chars»`);
  });

  it("masks every unterminated block, counting a second one into the first", () => {
    const out = redactSecretsInText(`-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}`);
    expect(out).not.toContain(PEM_LINE);
    expect(out).toMatch(/^-----BEGIN PRIVATE KEY-----\n«redacted \d+ chars»$/);
  });

  it("counts an oversized unterminated body instead of holding it", () => {
    // Big enough that buffering the body and rescanning it on every chunk
    // takes longer than the test timeout.
    const body = "AbCd0123+/".repeat(40_000);
    const masker = new StreamSecretMasker();
    masker.push("-----BEGIN PRIVATE KEY-----\n");
    for (let i = 0; i < body.length; i += 40) masker.push(body.slice(i, i + 40));
    expect(masker.flush()).toBe(`-----BEGIN PRIVATE KEY-----\n«redacted ${body.length} chars»`);
  });

  it("keeps masking a block that spans a mid-stream event boundary", () => {
    // What the SSE sink and the NDJSON tee both do: only a real stream
    // boundary tears the masker down, so item.updated cannot strand a body.
    const masker = new StreamSecretMasker();
    let out = "";
    for (const [i, chunk] of chunksOf(PEM, 40).entries()) {
      out += masker.push(chunk);
      if (i === 3) {
        expect(endsContentStream("item.updated")).toBe(false);
        expect(endsContentStream("thread.token-usage.updated")).toBe(false);
      }
    }
    expect(endsContentStream("turn.completed")).toBe(true);
    out += masker.flush();
    expect(out).not.toContain(PEM_LINE);
    expect(out).toBe(`-----BEGIN PRIVATE KEY-----\n«redacted ${PEM_BODY.length} chars»\n-----END PRIVATE KEY-----`);
  });

  it("is applied to string values inside redactSecrets too", () => {
    const out = redactSecrets({ command: "curl -H 'Authorization: Bearer abcdefghijklmnop'", note: "fine" }) as Record<string, string>;
    expect(out.command).toContain("«redacted");
    expect(out.note).toBe("fine");
  });

  it("emits ordinary short replies before flush when chunked into 5-character pieces", () => {
    const sentence = "This chat is a latency probe measuring how fast Maple replies.";
    const masker = new StreamSecretMasker();
    let beforeFlush = "";
    for (const chunk of chunksOf(sentence, 5)) beforeFlush += masker.push(chunk);
    expect(beforeFlush.length).toBeGreaterThan(20);
    expect(beforeFlush + masker.flush()).toBe(sentence);
  });
});

function pushChunks(chunks: string[]) {
  const masker = new StreamSecretMasker();
  const pieces: string[] = [];
  for (const chunk of chunks) pieces.push(masker.push(chunk));
  const flushed = masker.flush();
  return { pieces, flushed, out: pieces.join("") + flushed };
}

function everySplit(text: string): string[][] {
  const splits: string[][] = [chunksOf(text, 1)];
  for (let i = 1; i < text.length; i++) splits.push([text.slice(0, i), text.slice(i)]);
  return splits;
}

function seededChunks(text: string, seed: number): string[] {
  let s = seed >>> 0;
  const rand = () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const chunks: string[] = [];
  for (let i = 0; i < text.length; ) {
    const n = 1 + Math.floor(rand() * 17);
    chunks.push(text.slice(i, i + n));
    i += n;
  }
  return chunks;
}

function assertNoCredentialLeak(pieces: string[], secret: string) {
  for (const piece of pieces) {
    expect(piece, JSON.stringify(piece)).not.toContain(secret);
    if (secret.length >= 6) expect(piece).not.toContain(secret.slice(0, 6));
  }
}

describe("StreamSecretMasker incremental safety", () => {
  const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
  const pemLine = "AbCd0123+/".repeat(10);
  const pemBody = Array(8).fill(pemLine).join("\n");
  const jwt = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(16)}`;
  const families: Array<[string, string, string]> = [
    ["anthropic", `prose sk-ant-api03-${alpha} tail`, `sk-ant-api03-${alpha}`],
    ["openai", `prose sk-proj-${alpha}ABCD tail`, `sk-proj-${alpha}ABCD`],
    ["github", `prose ${"gh" + "p_"}${alpha}xxxx tail`, `${"gh" + "p_"}${alpha}xxxx`],
    ["github-pat", `prose ${"github_" + "pat_"}11ABCDEFG0${alpha} tail`, `${"github_" + "pat_"}11ABCDEFG0${alpha}`],
    ["slack", `prose ${"xox" + "b-"}${"123456789012"}-${"1234567890123"}-${alpha.slice(0, 24)} tail`, `${"xox" + "b-"}${"123456789012"}-${"1234567890123"}-${alpha.slice(0, 24)}`],
    ["aws", `prose ${"AKIA" + "IOSFODNN7EXAMPLE"} tail`, `${"AKIA" + "IOSFODNN7EXAMPLE"}`],
    ["google", `prose ${"AIza" + "SyA-"}${alpha.slice(0, 32)} tail`, `${"AIza" + "SyA-"}${alpha.slice(0, 32)}`],
    ["google-oauth", `prose ${"ya29" + "."}abcdefghijklmnop_0123456789-ABCD tail`, `${"ya29" + "."}abcdefghijklmnop_0123456789-ABCD`],
    ["npm", `prose ${"npm" + "_"}${alpha}xxxx tail`, `${"npm" + "_"}${alpha}xxxx`],
    ["xai", `prose ${"xai" + "-"}${alpha} tail`, `${"xai" + "-"}${alpha}`],
    ["stripe", `prose ${"sk" + "_"}live_51H${alpha.slice(0, 30)} tail`, `${"sk" + "_"}live_51H${alpha.slice(0, 30)}`],
    ["stripe-rk", `prose ${"rk" + "_"}live_51H${alpha.slice(0, 30)} tail`, `${"rk" + "_"}live_51H${alpha.slice(0, 30)}`],
    ["composio", `prose ${"ak" + "_"}${alpha.slice(0, 26)} tail`, `${"ak" + "_"}${alpha.slice(0, 26)}`],
    ["jwt", `prose ${jwt} tail`, jwt],
    ["bearer", `prose Bearer abcdefghijklmnop_0123 tail`, "abcdefghijklmnop_0123"],
    ["password", `prose password=abcdefgh!@suffix tail`, "abcdefgh!@suffix"],
    ["kv-quote-before-eq", `prose password"=abcdefghijklmn tail`, "abcdefghijklmn"],
    ["kv-spaces", `prose SECRET_KEY = 'abcdef123456789' tail`, "abcdef123456789"],
    ["kv-newlines", `prose token\n=\n${alpha.slice(0, 16)} tail`, alpha.slice(0, 16)],
    ["long-name", `prose VERY_LONG_CUSTOM_SERVICE_API_KEY=abcdefghijklmnop tail`, "abcdefghijklmnop"],
    ["quoted-config", `prose "key": "${"fw" + "_"}${"3a9c1e7b4d5a6f8e"}" tail`, `${"fw" + "_"}${"3a9c1e7b4d5a6f8e"}`],
    ["config-mismatch-dq-sq", `"key': "AbCdEf0123456789AbCdEf"`, "AbCdEf0123456789AbCdEf"],
    ["config-mismatch-sq-dq", `'key": "AbCdEf0123456789AbCdEf"`, "AbCdEf0123456789AbCdEf"],
    ["pem", `prose\n-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----\ntail`, pemLine],
  ];

  it("never leaks credential bytes in intermediate output for two-part, one-char, and seeded splits", () => {
    for (const [family, text, secret] of families) {
      const plans = [...everySplit(text), seededChunks(text, 1), seededChunks(text, 2), seededChunks(text, 99)];
      for (const chunks of plans) {
        const { pieces, out } = pushChunks(chunks);
        assertNoCredentialLeak(pieces, secret);
        expect(out, family).not.toContain(secret);
        expect(out, family).toMatch(/«redacted \d+ chars»/);
        expect(out, family).toBe(redactSecretsInText(text));
      }
    }
  });

  it("holds unfinished prefixes, long continuations, and overlapping families without leaking", () => {
    const key = `sk-ant-api03-${alpha}`;
    const password = "abcdefghijklmnop";
    const overlap = `password=${key}`;
    const prefix = pushChunks(["hello sk-ant"]);
    expect(prefix.pieces.join("")).not.toContain("sk-ant");
    expect(prefix.out).toContain("hello");

    const grown = pushChunks(["sk-ant-", "A".repeat(16), "B".repeat(20)]);
    assertNoCredentialLeak(grown.pieces, "A".repeat(16));
    assertNoCredentialLeak(grown.pieces, "B".repeat(20));
    expect(grown.out).toMatch(/^«redacted \d+ chars»$/);

    const mixed = pushChunks(chunksOf(overlap, 3));
    assertNoCredentialLeak(mixed.pieces, key);
    assertNoCredentialLeak(mixed.pieces, password);
    expect(mixed.out).not.toContain(key);

    const afterProse = `ordinary English then ${key} and more`;
    const streamed = pushChunks(chunksOf(afterProse, 7));
    expect(streamed.pieces.join("").length).toBeGreaterThan(10);
    assertNoCredentialLeak(streamed.pieces, key);
  });

  it("masks PEM begin/end splits, oversized bodies, and unclosed blocks without leaking", () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----`;
    for (const chunks of everySplit(pem).slice(0, 40)) {
      const { pieces, out } = pushChunks(chunks);
      assertNoCredentialLeak(pieces, pemLine);
      expect(out).not.toContain(pemLine);
    }
    const beginSplit = pushChunks(["-----BEGIN PRI", `VATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----`]);
    assertNoCredentialLeak(beginSplit.pieces, pemLine);
    const unclosed = pushChunks(chunksOf(`-----BEGIN PRIVATE KEY-----\n${pemBody}`, 9));
    assertNoCredentialLeak(unclosed.pieces, pemLine);
    expect(unclosed.out).toBe(`-----BEGIN PRIVATE KEY-----\n«redacted ${pemBody.length} chars»`);

    const huge = "AbCd0123+/".repeat(200);
    const masker = new StreamSecretMasker();
    const pieces = [masker.push("-----BEGIN PRIVATE KEY-----\n")];
    for (let i = 0; i < huge.length; i += 40) pieces.push(masker.push(huge.slice(i, i + 40)));
    pieces.push(masker.flush());
    assertNoCredentialLeak(pieces, "AbCd0123+/");
    expect(pieces.join("")).toBe(`-----BEGIN PRIVATE KEY-----\n«redacted ${huge.length} chars»`);
  });

  it("holds mismatched config-key name quotes the way the full matcher does", () => {
    const secret = "AbCdEf0123456789AbCdEf";
    const texts = [
      `"key': "${secret}"`,
      `'key": '${secret}'`,
      `"key': '${secret}'`,
      `'key": "${secret}"`,
      `"key": '${secret}'`,
      `'key': "${secret}"`,
      `"key' : "${secret}"`,
      `'key" : '${secret}'`,
    ];
    for (const text of texts) {
      const expected = redactSecretsInText(text);
      expect(expected, text).not.toContain(secret);
      expect(expected, text).toMatch(/«redacted 22 chars»/);
      for (const chunks of everySplit(text)) {
        const { pieces, out } = pushChunks(chunks);
        expect(pieces.join(""), text).not.toContain(secret);
        assertNoCredentialLeak(pieces, secret);
        expect(out, text).toBe(expected);
      }
    }
  });

  it("lets ordinary English, Korean, punctuation, URLs, code, and near-misses progress", () => {
    const samples = [
      "This chat is a latency probe measuring how fast Maple replies.",
      "안녕하세요. 이 채팅은 속도 측정용입니다.",
      "Hello, world! Question? Yes - wait, dash: ok.",
      "https://example.com/path?page=2&sort=asc",
      "const token = await getToken(); // fetches later",
      "the keyboard shortcut is cmd-k",
      "git commit 3f2a9c1e7b4d5a6f8e9c0b1a2d3e4f5a6b7c8d9e",
      "password: leave blank for now",
      "Bearer tokens are sent in the Authorization header",
      "sk-8 is too short to be a key",
      'the JSON field "key": "documentation"',
    ];
    for (const sample of samples) {
      const { pieces, out } = pushChunks(chunksOf(sample, 5));
      expect(pieces.join("").length, sample).toBeGreaterThan(Math.min(8, sample.length - 1));
      expect(out, sample).toBe(sample);
    }
  });
});
