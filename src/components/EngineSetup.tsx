// A focused setup card shared by onboarding, the model picker, and runtime
// errors. The command has one inline copy action and one primary next step;
// unusable model lists stay out of the way until the engine is ready.
import { useState } from "react";
import { Check, Copy, Download, ExternalLink, KeyRound, LogIn, TerminalSquare } from "lucide-react";
import { useStore, type EngineInstall, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";

type Platform = "darwin" | "win32" | "linux";

function hostPlatform(): Platform {
  const platform = window.ogb?.platform;
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  const userAgent = navigator.userAgent;
  if (userAgent.includes("Mac")) return "darwin";
  if (userAgent.includes("Win")) return "win32";
  return "linux";
}

/** The install command for this machine, or null when the engine has none
 * here (a GUI download, or a POSIX-only installer viewed on Windows). */
export function installCommandFor(install: EngineInstall | undefined): string | null {
  return install?.command?.[hostPlatform()] ?? null;
}

/** Installed but missing the cloud account session. */
export function needsSignIn(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state === "available" && instance.snapshot.authenticated === false;
}

/** The agent CLI itself is absent. Local-model injection needs the CLI but
 * does not need its cloud account to be signed in. */
export function needsCli(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state !== "available";
}

const API_KEY_DRIVERS = new Set(["geminiAgent", "opencodeGo"]);

export function isApiKeyEngine(instance: { driverKind?: string } | undefined): boolean {
  return API_KEY_DRIVERS.has(instance?.driverKind ?? "");
}

/** Installed CLI that still needs a pasted API key (Gemini, OpenCode). */
export function needsApiKey(instance: InstanceInfo | undefined): boolean {
  return Boolean(instance && isApiKeyEngine(instance) && needsSignIn(instance));
}

export function isApiKeySetupMessage(message: string): boolean {
  return /api key/i.test(message);
}

/** Null-instance fallback: Gemini/OpenCode copy only, not "Invalid API key". */
function isGeminiOrOpenCodeApiKeyMessage(message: string): boolean {
  return /gemini api key/i.test(message) || /opencode(?:\s*go)? api key/i.test(message);
}

/** What a failed turn should offer: install/sign-in, paste a key, or Retry.
 *
 * `/api key/` in the error text is not enough on its own — Grok/Claude can
 * say "Invalid API key" and still need Terminal, not Connections. With an
 * instance, match that text only for key engines (Gemini with `authenticated`
 * true/unset still gets the paste CTA). With no instance — ChatView omits it
 * when the error is not `setup` — only Gemini/OpenCode copy counts. */
export function setupErrorAction(
  message: string,
  instance: InstanceInfo | undefined,
): "cli" | "key" | "retry" {
  if (instance && needsCli(instance)) return "cli";
  if (needsApiKey(instance)) return "key";
  if (instance && isApiKeyEngine(instance) && isApiKeySetupMessage(message)) return "key";
  if (instance == null && isGeminiOrOpenCodeApiKeyMessage(message)) return "key";
  if (instance && needsSignIn(instance)) return "cli";
  return "retry";
}

export function OpenConnectionsCta({ className }: { className?: string }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  return (
    <button
      type="button"
      onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}
      className={cn(
        "mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110",
        className,
      )}
    >
      <KeyRound size={14} />
      {t("engine.openConnections")}
    </button>
  );
}

function CommandRow({ command, actionLabel }: { command: string; actionLabel: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<"copied" | "opened" | null>(null);
  const canOpen = Boolean(window.ogb?.openInstallTerminal);

  const settle = (next: "copied" | "opened") => {
    setStatus(next);
    window.setTimeout(() => setStatus(null), 2200);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      settle("copied");
    } catch {
      // The command remains selectable when clipboard access is blocked.
    }
  };

  const openTerminal = async () => {
    const opened = await window.ogb!.openInstallTerminal!(command);
    settle(opened ? "opened" : "copied");
  };

  return (
    <div className="mt-3">
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-hairline/50 bg-app px-2.5 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-secondary" title={command}>
          {command}
        </code>
        {canOpen && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={t("engine.copyCommand")}
            title={t("engine.copyCommand")}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-ink-secondary hover:bg-control hover:text-ink"
          >
            {status === "copied" ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            {status === "copied" ? t("engine.copied") : t("native.copy")}
          </button>
        )}
      </div>

      {canOpen ? (
        <>
          <button
            type="button"
            onClick={() => void openTerminal()}
            className="mt-2 flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110"
          >
            {status === "opened" ? <Check size={14} /> : <TerminalSquare size={14} />}
            {status === "opened" ? t("engine.terminalOpened") : actionLabel}
          </button>
          <p aria-live="polite" className="mt-1.5 text-center text-[11px] text-ink-secondary/70">
            {status === "opened" ? t("engine.pasteAndEnter") : t("engine.copiedWhenOpens")}
          </p>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void copy()}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[12.5px] font-semibold text-ink hover:bg-raised-hover"
        >
          {status === "copied" ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          {status === "copied" ? t("engine.commandCopied") : t("engine.copyCommand")}
        </button>
      )}
    </div>
  );
}

export function EngineSetup({
  instance,
  className,
  intent = "cloud",
}: {
  instance: InstanceInfo;
  className?: string;
  /** `inject` installs the CLI but deliberately skips cloud sign-in. */
  intent?: "cloud" | "inject";
}) {
  const { t } = useI18n();
  const install = instance.install;
  const installCommand = installCommandFor(install);
  const signInCommand = install?.signInCommand;
  const keyOnly = intent === "cloud" && needsApiKey(instance);
  const signInOnly = intent === "cloud" && needsSignIn(instance) && !keyOnly;
  const command = keyOnly ? null : signInOnly ? signInCommand : installCommand;
  const title = keyOnly
    ? t("engine.needsKeyTitle", { name: instance.displayName })
    : signInOnly
      ? t("engine.signInTo", { name: instance.displayName })
      : t("engine.installName", { name: instance.displayName });
  const description = keyOnly
    ? t("engine.needsKey")
    : signInOnly
      ? t("engine.signInBody")
      : intent === "inject"
        ? t("engine.injectBody")
        : signInCommand ? t("engine.installBodySignIn") : t("engine.installBody");

  // Some engines are configured elsewhere (for example, a cloud computer
  // token) and intentionally have no install descriptor.
  if (!install) {
    return (
      <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
        <div className="text-[13px] font-semibold text-ink">{t("engine.notReady", { name: instance.displayName })}</div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {instance.snapshot.reason ?? t("engine.notAvailable")}
        </p>
        {(keyOnly || isApiKeyEngine(instance)) && <OpenConnectionsCta />}
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
          {keyOnly ? <KeyRound size={14} /> : signInOnly ? <LogIn size={14} /> : <Download size={14} />}
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{title}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{description}</p>
        </div>
      </div>

      {keyOnly ? (
        <OpenConnectionsCta />
      ) : command ? (
        <CommandRow command={command} actionLabel={signInOnly ? t("engine.openSignIn") : t("engine.openInstall")} />
      ) : (
        <p className="mt-3 rounded-lg bg-inset px-2.5 py-2 text-[12px] leading-relaxed text-ink-secondary">
          {t("engine.noInstaller")}
        </p>
      )}

      {/* needsNode is engine-wide; only show it when this machine's command is npm. */}
      {!signInOnly && !keyOnly && install.needsNode && (installCommand?.includes("npm") ?? true) && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary/70">
          {t("engine.needsNode")}
        </p>
      )}

      {install.docsUrl && (
        <a
          href={install.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2.5 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"
        >
          <ExternalLink size={12} /> {t("engine.viewGuide")}
        </a>
      )}
    </div>
  );
}
