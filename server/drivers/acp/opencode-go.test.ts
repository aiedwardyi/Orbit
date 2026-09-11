import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import {
  classifyOpenCodeError,
  canListOpenCodeModels,
  createOpenCodeDriver,
  normalizeLegacyOpenCodeModel,
  parseOpenCodeModelsOutput,
  withOpenCodeWebSearch,
} from "./opencode-go.ts";
import type { ModelCatalog, SendTurnInput } from "../../contracts.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

const catalog = (...ids: string[]): ModelCatalog => ({
  default: ids[0]!,
  options: ids.map((id) => ({ id, label: id })),
});

describe("OpenCode catalog", () => {
  it("parses Zen, Go, third-party, and local models using exact CLI slugs", () => {
    const models = parseOpenCodeModelsOutput([
      "openrouter/vendor/model-v2",
      JSON.stringify({ name: "Vendor Model", status: "active" }, null, 2),
      "opencode/x-preview-f-free",
      JSON.stringify({ name: "Ox Alpha Free", status: "active", limit: { context: 1_000_000 } }, null, 2),
      "opencode-go/minimax-m3",
      JSON.stringify({ name: "MiniMax M3", status: "active" }, null, 2),
      "ollama/qwen3",
      JSON.stringify({ name: "Qwen 3", api: { url: "http://127.0.0.1:11434/v1" } }, null, 2),
      "lmstudio/qwen3-ipv6",
      JSON.stringify({ name: "Qwen 3 IPv6", api: { url: "http://[::1]:1234/v1" } }, null, 2),
      "opencode/retired",
      JSON.stringify({ name: "Retired", status: "deprecated" }, null, 2),
    ].join("\n"));

    expect(models?.default).toBe("opencode/x-preview-f-free");
    expect(models?.options).toEqual([
      expect.objectContaining({ id: "openrouter/vendor/model-v2", label: "OpenRouter · Vendor Model" }),
      expect.objectContaining({
        id: "opencode/x-preview-f-free",
        label: "Zen · Ox Alpha Free",
        contextWindow: 1_000_000,
      }),
      expect.objectContaining({ id: "opencode-go/minimax-m3", label: "Go · MiniMax M3" }),
      expect.objectContaining({ id: "ollama/qwen3", custom: true, loaded: true }),
      expect.objectContaining({ id: "lmstudio/qwen3-ipv6", custom: true, loaded: true }),
    ]);
  });

  it("caches the anonymous model probe across authentication checks", async () => {
    const runModels = vi.fn(async () => "opencode/x-preview-f-free\n");

    await expect(canListOpenCodeModels({}, "counting-opencode", runModels)).resolves.toBe(true);
    await expect(canListOpenCodeModels({}, "counting-opencode", runModels)).resolves.toBe(true);

    expect(runModels).toHaveBeenCalledOnce();
  });

  it("accepts header-only output from older CLIs and rejects malformed lines", () => {
    const models = parseOpenCodeModelsOutput([
      "Available models",
      "opencode/x-preview-f-free",
      "bad model/with space",
      "openrouter/anthropic/claude-sonnet-5",
    ].join("\n"));

    expect(models?.options.map((option) => option.id)).toEqual([
      "opencode/x-preview-f-free",
      "openrouter/anthropic/claude-sonnet-5",
    ]);
  });

  it("refreshes the same instance catalog on each explicit refresh", async () => {
    let calls = 0;
    const driver = createOpenCodeDriver(async () => {
      calls += 1;
      const id = calls === 1
        ? "opencode/x-preview-f-free"
        : calls === 2
          ? "opencode-go/extra-two"
          : "openrouter/vendor/extra-three";
      return catalog(id);
    });
    const instance = await driver.create({
      instanceId: "opencode-refresh",
      displayName: "OpenCode",
      environment: {},
      enabled: true,
      config: driver.defaultConfig(),
    });

    expect(instance.models.default).toBe("opencode/x-preview-f-free");
    expect(instance.models.options.some((option) => option.custom)).toBe(false);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "opencode-go/extra-two" && !option.custom)).toBe(true);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "openrouter/vendor/extra-three" && !option.custom)).toBe(true);
    await instance.dispose();
  });

  it("keeps the driver optional and declares the OpenCode CLI setup", () => {
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    expect(driver.driverKind).toBe("opencodeGo");
    expect(driver.metadata.displayName).toBe("OpenCode");
    expect(driver.decodeConfig(undefined)).toEqual({ cli: "opencode", fullAuto: false, workspace: undefined });
    expect(driver.install?.docsUrl).toContain("opencode.ai");
    expect(driver.install?.signInCommand).toBe("opencode auth login");
  });

  it("migrates the retired Ox preview id without changing current ids", () => {
    expect(normalizeLegacyOpenCodeModel("opencode-go/ox-alpha-free", {})).toBe(
      "opencode/x-preview-f-free",
    );
    expect(normalizeLegacyOpenCodeModel("opencode-go/ox-alpha-free", { OPENCODE_API_KEY: "configured" })).toBe(
      "opencode-go/x-preview-f-free",
    );
    expect(normalizeLegacyOpenCodeModel("opencode/gpt-5.6-sol", {})).toBe("opencode/gpt-5.6-sol");
  });

  it("recognizes an OpenCode Go login stored by the CLI", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-auth-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "stored-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
    const instance = await driver.create({
      instanceId: "opencode-auth",
      displayName: "OpenCode",
      environment: { XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("finds the CLI's login at ~/.local/share on every platform, macOS included", async () => {
    // `opencode auth list` prints ~/.local/share/opencode/auth.json on macOS —
    // the CLI is xdg-flavoured everywhere. Looking only in Library/Application
    // Support is the bug that told signed-in users to sign in. No XDG override
    // here on purpose: this is the exact real-world shape.
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-home-"));
    const authDir = join(scratch, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "stored-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
    const instance = await driver.create({
      instanceId: "opencode-home-auth",
      displayName: "OpenCode",
      environment: { HOME: scratch, USERPROFILE: scratch, XDG_DATA_HOME: "", OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("recognizes an existing OpenCode Zen login", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-oauth-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      opencode: { type: "oauth", access: "acc-token", refresh: "ref-token" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-oauth-auth",
      displayName: "OpenCode",
      environment: { XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("treats OpenCode's anonymous free catalog as runnable without a saved key", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-free-"));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-free",
      displayName: "OpenCode",
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        XDG_DATA_HOME: join(scratch, "data"),
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("runs a Zen model through ACP using the exact discovered id", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-zen-only-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      opencode: { type: "api", key: "zen-only-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-zen-only",
      displayName: "OpenCode",
      environment: {
        XDG_DATA_HOME: scratch,
        OPENCODE_API_KEY: "",
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-opencode-zen-only",
        text: "hello",
        model: "opencode/x-preview-f-free",
      });
      const done = await recorder.until((event) => event.type === "turn.completed");
      expect(done).toMatchObject({ ok: true });
      expect(recorder.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "session.started", model: "opencode/x-preview-f-free" }),
      ]));
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("allows websearch in OpenCode config before an ACP turn", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-websearch-"));
    const dump = join(scratch, "acp.json");
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-websearch",
      displayName: "OpenCode",
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        FAKE_ACP_DUMP: dump,
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-opencode-websearch",
        text: "hello",
        model: "opencode/x-preview-f-free",
      });
      await recorder.until((event) => event.type === "turn.completed");
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.env.OPENCODE_CONFIG_CONTENT).toContain('"websearch":"allow"');
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("keeps other OPENCODE_CONFIG_CONTENT keys when allowing websearch", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-websearch-merge-"));
    const dump = join(scratch, "acp.json");
    const prior = { model: "opencode/kept-model", permission: { bash: "ask" } };
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-websearch-merge",
      displayName: "OpenCode",
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        FAKE_ACP_DUMP: dump,
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(prior),
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-opencode-websearch-merge",
        text: "hello",
        model: "opencode/x-preview-f-free",
      });
      await recorder.until((event) => event.type === "turn.completed");
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      const sent = JSON.parse(seen.env.OPENCODE_CONFIG_CONTENT);
      expect(sent.model).toBe("opencode/kept-model");
      expect(sent.permission).toEqual({ bash: "ask", websearch: "allow" });
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("asks before OpenCode edits and commands in Ask mode, keeping websearch", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-ask-"));
    const dump = join(scratch, "acp.json");
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-ask",
      displayName: "OpenCode",
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        FAKE_ACP_DUMP: dump,
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: "allow" } }),
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
    });
    const recorder = recordEvents(instance.adapter);
    const permissionFor = async (approval: "ask" | "auto") => {
      const { turnId } = await instance.adapter.sendTurn({
        threadId: `t-opencode-${approval}`,
        text: "hello",
        model: "opencode/x-preview-f-free",
        approval,
      });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      return JSON.parse(JSON.parse(readFileSync(dump, "utf8")).env.OPENCODE_CONFIG_CONTENT).permission;
    };
    try {
      expect(await permissionFor("ask")).toEqual({ bash: "ask", edit: "ask", websearch: "allow" });
      expect(await permissionFor("auto")).toEqual({ bash: "allow", websearch: "allow" });
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("classifies ACP's standard authentication error", () => {
    expect(classifyOpenCodeError({ code: -32000 })).toBe("invalid_credentials");
  });

  it("keeps the OpenCode key in the child environment only", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-go-"));
    try {
      const dump = join(scratch, "env.json");
      const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
      const instance = await driver.create({
        instanceId: "opencode-go",
        displayName: "OpenCode",
        environment: {
          OPENCODE_API_KEY: "secret-value",
          OPENAI_API_KEY: "wrong-provider-secret",
          ANTHROPIC_API_KEY: "wrong-provider-secret",
          FAKE_ACP_DUMP: dump,
        },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      await instance.snapshot();
      const child = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
      expect(child.env.OPENCODE_API_KEY).toBe("secret-value");
      expect(child.env.OPENAI_API_KEY).toBeUndefined();
      expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
      await instance.dispose();
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("keeps the OpenCode key on the models child and drops ungranted tokens", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-catalog-env-"));
    try {
      const dump = join(scratch, "catalog.json");
      const driver = createOpenCodeDriver();
      const instance = await driver.create({
        instanceId: "opencode-catalog-env",
        displayName: "OpenCode",
        environment: {
          FAKE_ACP_DUMP: dump,
          FAKE_ACP_MODELS: "opencode/x-preview-f-free",
          OPENCODE_API_KEY: "opencode-key-synthetic",
          UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-catalog-synthetic",
          AWS_SECRET_ACCESS_KEY: "aws-catalog-synthetic",
        },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      const seen = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string> };
      expect(seen.argv).toEqual(["models", "--verbose"]);
      expect(seen.env.OPENCODE_API_KEY).toBe("opencode-key-synthetic");
      expect(seen.env.UNSLOTH_STUDIO_AUTH_TOKEN).toBeUndefined();
      expect(seen.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      await instance.dispose();
    } finally {
      await removeTempDir(scratch);
    }
  });
});

describe("OpenCode Ask for approval", () => {
  const permissionFor = async (
    raw: string | undefined,
    files: Record<string, string> = {},
    ask = true,
    cwd?: string,
    extraEnv: Record<string, string> | ((scratch: string) => Record<string, string>) = {},
  ) => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-deny-"));
    try {
      mkdirSync(join(scratch, "opencode"));
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(scratch, name)), { recursive: true });
        writeFileSync(join(scratch, name), text);
      }
      const env = {
        XDG_CONFIG_HOME: scratch,
        HOME: scratch,
        USERPROFILE: scratch,
        OPENCODE_CONFIG: files.custom && join(scratch, "custom"),
        ...(extraEnv instanceof Function ? extraEnv(scratch) : extraEnv),
      };
      return JSON.parse(withOpenCodeWebSearch(raw, ask, env, cwd && join(scratch, cwd))).permission;
    } finally {
      await removeTempDir(scratch);
    }
  };
  const inline = (permission: Record<string, string | Record<string, string>> | string) =>
    JSON.stringify({ permission });

  it("keeps a bash deny", async () => {
    expect(await permissionFor(inline({ bash: "deny" }))).toEqual({ bash: "deny", edit: "ask", websearch: "allow" });
  });

  it("keeps deny patterns and asks for the rest", async () => {
    const permission = await permissionFor(inline({ bash: { "*": "allow", "git *": "allow", "rm *": "deny" } }));
    expect(Object.entries(permission.bash)).toEqual([["*", "ask"], ["git *", "ask"], ["rm *", "deny"]]);
  });

  it("puts the catch-all first when a pattern map has none", async () => {
    const permission = await permissionFor(inline({ edit: { "*.env": "deny" } }));
    expect(Object.entries(permission.edit)).toEqual([["*", "ask"], ["*.env", "deny"]]);
  });

  it("turns allow into ask", async () => {
    expect(await permissionFor(inline({ bash: "allow", edit: "allow" }))).toEqual({ bash: "ask", edit: "ask", websearch: "allow" });
  });

  it("asks when nothing is set", async () => {
    expect(await permissionFor(undefined)).toEqual({ bash: "ask", edit: "ask", websearch: "allow" });
  });

  it("keeps a deny from the global config files and OPENCODE_CONFIG", async () => {
    expect(await permissionFor(undefined, {
      "opencode/opencode.json": inline({ bash: "allow" }),
      "opencode/opencode.jsonc": `// user\n{ "permission": { "bash": "deny", }, }\n`,
    })).toMatchObject({ bash: "deny", edit: "ask" });
    expect(await permissionFor(undefined, { custom: inline({ edit: "deny" }) })).toMatchObject({ bash: "ask", edit: "deny" });
  });

  it("keeps a top-level deny that bash and edit would otherwise override", async () => {
    expect(await permissionFor(undefined, { "opencode/config.json": inline("deny") })).toMatchObject({ bash: "deny", edit: "deny" });
  });

  it("keeps a top-level deny under an inline pattern map without a catch-all", async () => {
    const files = { "opencode/opencode.json": inline("deny") };
    const permission = await permissionFor(inline({ bash: { "git *": "allow" } }), files);
    expect(Object.entries(permission.bash)).toEqual([["*", "deny"], ["git *", "ask"]]);
  });

  it("denies an inherited pattern map without a catch-all under a top-level deny", async () => {
    const files = { "opencode/opencode.json": JSON.stringify({ permission: { "*": "deny", bash: { "git *": "allow" } } }) };
    expect((await permissionFor(undefined, files)).bash).toBe("deny");
  });

  it("denies an inherited deny map that has no catch-all", async () => {
    const files = { "opencode/opencode.json": inline({ bash: { "rm *": "deny" } }) };
    expect((await permissionFor(inline({ bash: { "git *": "allow" } }), files)).bash).toBe("deny");
  });

  it("keeps a project deny from the git root down to cwd", async () => {
    const files = {
      "opencode.json": inline({ edit: "deny" }),
      "repo/.git/HEAD": "ref: refs/heads/main\n",
      "repo/opencode.json": inline({ bash: "deny" }),
    };
    expect(await permissionFor(undefined, files, true, "repo/sub")).toMatchObject({ bash: "deny", edit: "ask" });
    const dotted = { ...files, "repo/sub/.opencode/opencode.jsonc": `// user\n${inline({ edit: "deny" })}` };
    expect(await permissionFor(undefined, dotted, true, "repo/sub")).toMatchObject({ bash: "deny", edit: "deny" });
  });

  it("skips project config only when OPENCODE_DISABLE_PROJECT_CONFIG is 1 or true", async () => {
    const files = { "repo/.git/HEAD": "ref: refs/heads/main\n", "repo/opencode.json": inline({ bash: "deny" }) };
    const bashFor = async (flag: string) =>
      (await permissionFor(undefined, files, true, "repo", { OPENCODE_DISABLE_PROJECT_CONFIG: flag })).bash;
    expect(await bashFor("false")).toBe("deny");
    expect(await bashFor("0")).toBe("deny");
    expect(await bashFor("TRUE")).toBe("ask");
  });

  it("reads a relative OPENCODE_CONFIG against the turn cwd", async () => {
    const files = { "repo/.git/HEAD": "ref: refs/heads/main\n", "repo/rel/custom.json": inline({ bash: "deny" }) };
    const env = { OPENCODE_CONFIG: "rel/custom.json" };
    expect((await permissionFor(undefined, files, true, "repo", env)).bash).toBe("deny");
  });

  it.skipIf(process.platform === "win32")("reads a relative OPENCODE_CONFIG from the real cwd behind a symlink", async () => {
    const files = {
      "repo/.git/HEAD": "ref: refs/heads/main\n",
      "repo/custom.json": inline({ bash: "deny" }),
      "repo/sub/opencode.json": "",
      "outer/custom.json": inline({ bash: "allow" }),
    };
    const link = (scratch: string) => {
      symlinkSync(join(scratch, "repo", "sub"), join(scratch, "outer", "link"));
      return { OPENCODE_CONFIG: "../custom.json" };
    };
    expect((await permissionFor(undefined, files, true, "outer/link", link)).bash).toBe("deny");
  });

  it.skipIf(process.platform !== "win32")("reads a relative OPENCODE_CONFIG from the lexical cwd behind a junction", async () => {
    const files = {
      "repo/.git/HEAD": "ref: refs/heads/main\n",
      "repo/custom.json": inline({ bash: "allow" }),
      "repo/sub/opencode.json": "",
      "outer/custom.json": inline({ bash: "deny" }),
    };
    const link = (scratch: string) => {
      symlinkSync(join(scratch, "repo", "sub"), join(scratch, "outer", "link"), "junction");
      return { OPENCODE_CONFIG: "../custom.json" };
    };
    expect((await permissionFor(undefined, files, true, "outer/link", link)).bash).toBe("deny");
  });

  it("keeps a deny from OPENCODE_CONFIG_DIR over the project files", async () => {
    const files = {
      "repo/.git/HEAD": "ref: refs/heads/main\n",
      "repo/opencode.json": inline({ bash: "allow" }),
      "cfg/opencode.jsonc": inline({ bash: "deny" }),
    };
    const env = (scratch: string) => ({ OPENCODE_CONFIG_DIR: join(scratch, "cfg") });
    expect((await permissionFor(undefined, files, true, "repo", env)).bash).toBe("deny");
  });

  it("walks project config and inline {file:} from the real cwd behind a junction", async () => {
    const files = {
      "opencode/opencode.json": inline({ edit: "deny" }),
      "repo/.git/HEAD": "ref: refs/heads/main\n",
      "repo/opencode.json": inline({ bash: "deny" }),
      "repo/rule.txt": "deny",
      "repo/sub/opencode.json": "",
      "outer/opencode.json": inline({ edit: "allow" }),
      "outer/rule.txt": "allow",
    };
    const link = (scratch: string) => {
      symlinkSync(join(scratch, "repo", "sub"), join(scratch, "outer", "link"), "junction");
      return {};
    };
    expect(await permissionFor(undefined, files, true, "outer/link", link)).toMatchObject({ bash: "deny", edit: "deny" });
    expect((await permissionFor(inline({ edit: "{file:../rule.txt}" }), files, true, "outer/link", link)).edit).toBe("deny");
  });

  it("substitutes {env:} in names, values and unquoted text", async () => {
    const env = { QA_V: "deny", QA_N: "bash", QA_S: '"ask"' };
    const named = { "opencode/opencode.json": '{"permission":{"{env:QA_N}":"{env:QA_V}"}}' };
    expect((await permissionFor(undefined, named, true, undefined, env)).bash).toBe("deny");
    const unquoted = { "opencode/opencode.json": '{"permission":{"bash":{env:QA_S},"edit":"deny"}}' };
    expect(await permissionFor(undefined, unquoted, true, undefined, env)).toMatchObject({ bash: "ask", edit: "deny" });
    expect((await permissionFor(inline({ edit: "{env:QA_V}" }), {}, true, undefined, env)).edit).toBe("deny");
  });

  it("reads {file:} next to its config, from home, and inline from cwd", async () => {
    const files = {
      "edit.txt": "deny",
      "opencode/opencode.json": inline({ edit: "{file:~/edit.txt}" }),
      "repo/.git/HEAD": "ref: refs/heads/main\n",
      "repo/.opencode/opencode.json": inline({ bash: "{file:rule.txt}" }),
      "repo/.opencode/rule.txt": " deny \n",
      "repo/rule.txt": "allow",
    };
    expect(await permissionFor(undefined, files, true, "repo")).toMatchObject({ bash: "deny", edit: "deny" });
    const cwdFile = { "repo/.git/HEAD": "ref: refs/heads/main\n", "repo/rule.txt": "deny" };
    expect((await permissionFor(inline({ bash: "{file:rule.txt}" }), cwdFile, true, "repo")).bash).toBe("deny");
  });

  it("denies bash and edit when a {file:} is missing or a source will not parse", async () => {
    const comment = { "opencode/opencode.jsonc": `// "x": "{file:missing.txt}"\n${inline({ bash: "deny" })}` };
    expect(await permissionFor(undefined, comment)).toMatchObject({ bash: "deny", edit: "ask" });
    const missing = { "opencode/opencode.json": inline({ bash: "{file:missing.txt}" }) };
    expect(await permissionFor(undefined, missing)).toMatchObject({ bash: "deny", edit: "deny" });
    expect(await permissionFor('{"permission":{"bash":{env:QA_UNSET}}}')).toMatchObject({ bash: "deny", edit: "deny" });
  });

  it("reads a config file saved with a BOM", async () => {
    const files = { "repo/.git/HEAD": "ref: refs/heads/main\n", "repo/opencode.json": `\uFEFF${inline({ bash: "deny" })}` };
    expect(await permissionFor(undefined, files, true, "repo")).toMatchObject({ bash: "deny", edit: "ask" });
  });

  it("carries a map-valued top-level deny into the key's rule", async () => {
    const permission = { "*": { "*": "allow", "*.env": "deny" }, edit: { "*.txt": "allow" } };
    const edit = (await permissionFor(inline(permission))).edit;
    expect(Object.entries(edit)).toEqual([["*", "ask"], ["*.env", "deny"], ["*.txt", "ask"]]);
    expect((await permissionFor(undefined, { "opencode/opencode.json": inline(permission) })).edit).toBe("deny");
  });

  it("keeps a deny from a wildcard permission name", async () => {
    const files = { "opencode/opencode.json": inline({ "b*": "deny", EDIT: "deny" }) };
    expect(await permissionFor(undefined, files)).toMatchObject({ bash: "deny", edit: "deny" });
    const cased = { "opencode/opencode.json": inline({ "b*": "deny", BASH: "allow" }) };
    expect((await permissionFor(undefined, cased)).bash).toBe("deny");
  });

  it("leaves Auto mode unchanged", async () => {
    const files = { "opencode/opencode.json": inline({ bash: "deny" }) };
    expect(await permissionFor(inline({ bash: "allow" }), files, false)).toEqual({ bash: "allow", websearch: "allow" });
  });
});

// What the picker chose is not evidence; what left the driver is. These read
// the session/set_config_option calls the CLI actually received, because
// `session.started` falls back to the requested id and would report a model
// that never reached the wire.
describe("OpenCode outbound model", () => {
  const ZEN = "opencode/x-preview-f-free";
  const PICKED = "openrouter/rednote-hilab/dots3-note-preview:free";

  interface ConfigCall {
    method: string;
    params: { sessionId?: string; configId?: string; value?: string };
  }

  async function turnWire(options: {
    instanceId: string;
    sessionModels: string[];
    model?: string;
  }) {
    const scratch = mkdtempSync(join(tmpdir(), `omb-${options.instanceId}-`));
    const dump = join(scratch, "wire.json");
    const driver = createOpenCodeDriver(async () => catalog(...options.sessionModels));
    const instance = await driver.create({
      instanceId: options.instanceId,
      displayName: "OpenCode",
      environment: {
        XDG_DATA_HOME: join(scratch, "data"),
        FAKE_ACP_DUMP: dump,
        // the fake's first id is the session's own current model, so a pick
        // of any other id is a real switch the driver has to transmit
        FAKE_ACP_MODELS: options.sessionModels.join(","),
        OPENCODE_API_KEY: "opencode-wire-synthetic",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      const input: SendTurnInput = {
        threadId: `t-${options.instanceId}`,
        text: "which model are you?",
      };
      if (options.model) input.model = options.model;
      await instance.adapter.sendTurn(input);
      const done = await recorder.until((event) => event.type === "turn.completed");
      const sidecar = `${dump}.config.json`;
      const calls: ConfigCall[] = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, "utf8")) : [];
      return { done, events: [...recorder.events], calls };
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  }

  it("puts the picked model id on the wire verbatim", async () => {
    const { done, calls } = await turnWire({
      instanceId: "opencode-wire-pick",
      sessionModels: [ZEN, PICKED],
      model: PICKED,
    });

    expect(done).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "fake-acp-session", configId: "model", value: PICKED },
    });
  });

  it("puts the rewritten id on the wire, not the retired one the picker held", async () => {
    const { done, calls } = await turnWire({
      instanceId: "opencode-wire-legacy",
      sessionModels: [ZEN, "opencode-go/x-preview-f-free"],
      model: "opencode-go/ox-alpha-free",
    });

    expect(done).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "session/set_config_option",
      params: { configId: "model", value: "opencode-go/x-preview-f-free" },
    });
  });

  // The gap behind "it answered as a model I did not pick": with no model the
  // driver transmits none and the CLI keeps its own, while session.started
  // still names a model. Reachable only through the driver API: both
  // server/index.ts dispatch sites pass a model today.
  it("transmits no model when the turn carries none, leaving the CLI's own", async () => {
    const { done, events, calls } = await turnWire({
      instanceId: "opencode-wire-nomodel",
      sessionModels: [ZEN, PICKED],
    });

    expect(done).toMatchObject({ ok: true });
    expect(calls).toEqual([]);
    expect(events.find((event) => event.type === "session.started")).toMatchObject({ model: ZEN });
  });
});
