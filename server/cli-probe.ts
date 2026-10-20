import { existsSync } from "node:fs";
import { cliProbeEnvironment } from "./config.ts";
import type { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { augmentedPath, findCliCandidates, splitCliString } from "./env-path.ts";
import { describeSpawnFailure, execCli } from "./procs.ts";
import { redactSecretsInText } from "./redact.ts";

/** Pre-save probe for a CLI path override: run `<cli> --version` with the
 * same environment a real turn gets (augmented PATH). Returns ok + the
 * version line, or a fail the UI can act on — ENOENT on a GUI-launched app
 * usually means "not on the app's PATH", the exact mistake this catches
 * before the override is saved. */
export async function testCliBinary(cli: string, driver: (typeof BUILT_IN_DRIVERS)[number] | undefined): Promise<CliProbe> {
  const invalid = probeCommandError(cli);
  if (invalid) {
    const failure: CliProbe = { ok: false, message: invalid };
    if (driver?.install) failure.install = driver.install;
    return failure;
  }
  return new Promise((resolve) => {
    execCli(
      cli,
      ["--version"],
      {
        timeout: 10_000,
        // SIGKILL, not SIGTERM: a child that traps TERM (sh -c "trap '' TERM;
        // sleep 99999") would otherwise never fire the callback and pin the
        // HTTP socket forever. maxBuffer bounds a chatty --version too.
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 64,
        env: { ...cliProbeEnvironment(), PATH: augmentedPath() },
      },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          // err.code is an errno CONSTANT ("ENOENT", "EACCES") only for spawn
          // failures; for a non-zero exit it's the exit STATUS (a number) and
          // for a timeout it's null + killed:true — describeSpawnFailure words
          // only the first kind
          const exceededBuffer = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          const isSpawnError = typeof e.code === "string" && !exceededBuffer;
          const message = exceededBuffer
            ? "CLI test produced more than 64 KiB of output"
            : isSpawnError
              ? describeSpawnFailure(e, cli).message
              : e.killed
              ? "CLI test timed out after 10s"
              : `CLI exited with error ${String(e.code)}: ${(stderrOf(err) || "").slice(0, 200) || err.message.split("\n")[0]}`;
          resolve({ ok: false, message, ...(driver?.install && isSpawnError ? { install: driver.install } : {}) });
          return;
        }
        // one redacted, bounded line: whatever the caller pointed this at, the
        // response is a version string, not a window into the child's output
        resolve({ ok: true, version: redactSecretsInText(stdout.trim().split("\n")[0] ?? "").slice(0, PROBE_VERSION_MAX) });
      },
    );
  });
}

interface CliProbe {
  ok: boolean;
  version?: string;
  message?: string;
  install?: (typeof BUILT_IN_DRIVERS)[number]["install"];
}

/** A version line, not a transcript. */
const PROBE_VERSION_MAX = 200;

/** What a wrapper's fixed argument looks like: a subcommand, a flag, or a
 * path. An inline script payload needs characters no engine subcommand has —
 * spaces, quotes, parentheses, `;`, `|`, `$`. */
const PROBE_ARG = /^[A-Za-z0-9._@:+=/\\-]+$/;

/** A single-dash flag, which is how every interpreter spells "the next
 * argument is the program": `sh -c`, `python -c`, `node -e`, `awk -f`,
 * `powershell -Command`. `sh -c id` is two ordinary words to the rule above,
 * so the flag is the only thing that marks it as command evaluation. */
const PROBE_SHORT_FLAG = /^-[^-]/;

/** The same instruction spelled long. */
const PROBE_EVAL_FLAG = /^--(eval|command|exec|expression|print|script|require|import|load|preload)(=|$)/i;

/** A file an interpreter would execute. `node x.mjs` reads as a plain path to
 * the rule above, so the extension is what separates a wrapper's subcommand
 * from a script handed to this route to run. Renaming a script defeats it —
 * this narrows the endpoint, it does not seal it; the child env allowlist and
 * the redacted, bounded output are what make the run uninteresting. */
const PROBE_SCRIPT_ARG = /\.(js|mjs|cjs|ts|mts|cts|jar|sh|bash|zsh|fish|py|rb|pl|php|lua|ps1|psm1|bat|cmd|vbs)$/i;

/** Reject a `cli` this route must not run, wording the failure the way a
 * failed spawn would. Two rules: the command has to be a real executable, and
 * its fixed arguments have to be a wrapper's own — a subcommand, a long flag,
 * or a non-script path. `sh -c id`, `node -e "…"` and `node ./x.mjs` all fail
 * the second one.
 *
 * This narrows the endpoint; it does not seal it. A head that is itself a
 * runner (`env id`, `timeout 5 id`) still reaches a command, so what keeps a
 * steered probe uninteresting is the allowlisted child env and the redacted,
 * bounded line it answers with — not this check. */
function probeCommandError(cli: string): string | null {
  const notInstalled = (name: string) => {
    const enoent: NodeJS.ErrnoException = new Error(`spawn ${name} ENOENT`);
    enoent.code = "ENOENT";
    return describeSpawnFailure(enoent, name).message;
  };
  const [command, ...fixed] = splitCliString(cli);
  if (!command) return notInstalled(cli);
  // findCliCandidates resolves a bare name on the augmented PATH and echoes a
  // path-ish one back unchecked, so the existsSync covers both spellings
  const [resolved] = findCliCandidates(command);
  if (!resolved || !existsSync(resolved)) return notInstalled(command);
  const runsACommand = (arg: string) =>
    PROBE_SHORT_FLAG.test(arg) || PROBE_EVAL_FLAG.test(arg) || PROBE_SCRIPT_ARG.test(arg);
  // the existsSync fallback lets a path with spaces through, so it is checked
  // last and never rescues an argument already refused above
  if (fixed.some((arg) => runsACommand(arg) || !(PROBE_ARG.test(arg) || existsSync(arg)))) {
    return `\`${cli}\` is not a CLI path — a fixed argument may be a subcommand, a long flag, or a non-script path`;
  }
  return null;
}

/** execFile's error carries the child's stderr in .stderr. */
function stderrOf(err: unknown): string {
  const s = (err as { stderr?: unknown }).stderr;
  return typeof s === "string" ? s : Buffer.isBuffer(s) ? s.toString("utf8") : "";
}
