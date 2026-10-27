// A focused setup card shared by onboarding, the model picker, and runtime
// errors. The command has one inline copy action and one primary next step;
// unusable model lists stay out of the way until the engine is ready.
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, ExternalLink, LogIn, TerminalSquare } from "lucide-react";
import { api, useEngineLoginRefresh, type EngineInstall, type InstanceInfo } from "@/state/store";
import { isPhone } from "@/lib/phone-swipe";
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

/** Open a terminal with the install command, falling back to the clipboard.
 *
 * The `engine:open-terminal` invoke rejects when the packaged main has no
 * handler for it (or the handler throws) — without this the Install button
 * silently does nothing: no terminal, no copy, no feedback. A `false`
 * resolve trusts main's clipboard contract (it copies before reporting
 * failure); only a rejection re-copies here, since main may never have run.
 * A throwing `copy` propagates so the caller shows no false "copied". */
export async function openInstallTerminalOrCopy(
  command: string,
  opener: (() => Promise<boolean>) | undefined,
  copy: (text: string) => Promise<void>,
): Promise<"opened" | "copied"> {
  if (!opener) {
    await copy(command);
    return "copied";
  }
  let opened: boolean;
  try {
    opened = await opener();
  } catch {
    await copy(command);
    return "copied";
  }
  return opened ? "opened" : "copied";
}

export function installSignsIn(install: EngineInstall | undefined): boolean {
  return Boolean(install?.signInCommand && !/\bYOUR_[A-Z0-9_]+\b/.test(install.signInCommand));
}

export async function openEngineInstallOrCopy(instanceId: string, command: string, installOnly = false): Promise<"running" | "opened" | "copied"> {
  if (window.ogb?.openEngineInstall) {
    try {
      return await (installOnly ? window.ogb.openEngineInstall(instanceId, true) : window.ogb.openEngineInstall(instanceId));
    } catch (error) {
      // Older desktop builds expose the preload call without its main handler.
      if (!String(error).includes("No handler registered")) console.error("[engine-install] install failed:", error);
    }
  }
  return openInstallTerminalOrCopy(command, () => window.ogb!.openInstallTerminal!(command), (text) =>
    navigator.clipboard.writeText(text),
  );
}

/** What a failed turn should offer: install/sign-in or Retry. */
export function setupErrorAction(
  instance: InstanceInfo | undefined,
  signIn?: boolean,
): "cli" | "retry" {
  if (instance && needsCli(instance)) return "cli";
  if (instance && (needsSignIn(instance) || signIn)) return "cli";
  return "retry";
}

export function CommandRow({ command, actionLabel, signInInstanceId, installInstanceId, installOnly, signsIn, docsUrl, quiet = false }: { command: string; actionLabel: string; signInInstanceId?: string; installInstanceId?: string; installOnly?: boolean; signsIn?: boolean; docsUrl?: string; quiet?: boolean }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<"copied" | "opened" | "running" | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const canOpen = Boolean(signInInstanceId ? window.ogb?.openEngineSignIn : (installInstanceId && window.ogb?.openEngineInstall) || window.ogb?.openInstallTerminal);
  const automaticSignIn = Boolean(signInInstanceId && !/\bYOUR_[A-Z0-9_]+\b/.test(command));

  const settle = (next: "copied" | "opened" | "running") => {
    setStatus(next);
    window.setTimeout(() => setStatus(null), 2200);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopyFailed(false);
      settle("copied");
    } catch {
      if (installInstanceId && !canOpen) setCopyFailed(true);
      // The command remains selectable when clipboard access is blocked.
    }
  };

  const openTerminal = async () => {
    try {
      if (signInInstanceId) {
        try {
          settle(await window.ogb!.openEngineSignIn!(signInInstanceId));
        } catch {
          await copy();
        }
        return;
      }
      if (installInstanceId) {
        settle(await openEngineInstallOrCopy(installInstanceId, command, installOnly));
        return;
      }
      settle(
        await openInstallTerminalOrCopy(command, () => window.ogb!.openInstallTerminal!(command), (text) =>
          navigator.clipboard.writeText(text),
        ),
      );
    } catch {
      if (installInstanceId) setCopyFailed(true);
      // Clipboard blocked too: the command stays selectable, and no false
      // "copied" is shown.
    }
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

      {copyFailed && installInstanceId && docsUrl ? (
        <a href={docsUrl} target="_blank" rel="noreferrer"
          className={cn("mt-2 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-[12.5px] font-semibold",
            quiet ? "bg-control text-ink hover:bg-raised-hover" : "whitespace-nowrap bg-accent text-accent-ink hover:brightness-110")}>
          <ExternalLink size={14} />{t("engines.install")}
        </a>
      ) : canOpen ? (
        <>
          <button
            type="button"
            onClick={() => void openTerminal()}
            className={cn("mt-2 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-[12.5px] font-semibold",
              quiet ? "bg-control text-ink hover:bg-raised-hover" : "whitespace-nowrap bg-accent text-accent-ink hover:brightness-110")}
          >
            {status === "opened" || status === "running" ? <Check size={14} /> : <TerminalSquare size={14} />}
            {status === "opened" || status === "running" ? t("engine.terminalOpened") : actionLabel}
          </button>
          <p aria-live="polite" className="mt-1.5 text-center text-[11px] text-ink-secondary/70">
            {status === "copied" ? t("engine.commandCopied")
              : status === "opened" ? t("engine.pasteAndEnter")
                : status === "running" && !signInInstanceId && !signsIn ? t("engine.installRunning")
                  : status === "running" || automaticSignIn ? t("engine.followSignIn") : t("engine.copiedWhenOpens")}
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

export function EngineSignIn({ instance, onUpdated }: { instance: InstanceInfo; onUpdated?: (instance: InstanceInfo) => void }) {
  const { t } = useI18n();
  const [current, setCurrent] = useState(instance);
  const [waiting, setWaiting] = useState(instance.loginState === "pending");
  const [failed, setFailed] = useState(instance.loginState === "failed");
  const [capture, setCapture] = useState(instance.loginCapture ?? {});
  const [copyFallback, setCopyFallback] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const phone = !window.ogb && isPhone();
  const external = instance.driverKind === "antigravityAgent";
  const login = instance.install?.login;
  const computerOnly = phone && (external || !login?.deviceArgs);
  // Same argv both ways is a device-only flow (Muse): nothing opens on desktop either.
  const deviceFlow = phone || Boolean(login?.deviceArgs && login.deviceArgs.length === login.args.length && login.deviceArgs.every((arg, i) => arg === login.args[i]));
  const connected = current.snapshot.state === "available" && current.snapshot.authenticated === true;
  const path = `/api/instances/${encodeURIComponent(instance.instanceId)}/sign-in`;

  useEffect(() => {
    setWaiting(instance.loginState === "pending");
    setFailed(instance.loginState === "failed");
    setCapture(instance.loginCapture ?? {});
    setCopyFallback(false);
    setBusy(false);
    return () => { generation.current += 1; };
  }, [instance.instanceId]);
  useEffect(() => {
    setCurrent(instance);
    if (instance.loginState === "pending") {
      setWaiting(true);
      setCapture(instance.loginCapture ?? {});
    }
    if (instance.snapshot.authenticated === true) setWaiting(false);
  }, [instance]);

  useEngineLoginRefresh(waiting, (instances) => {
    const next = instances.find((row) => row.instanceId === instance.instanceId);
    if (!next) return;
    setCurrent(next);
    setCapture(next.loginCapture ?? {});
    onUpdated?.(next);
    if (next.snapshot.authenticated === true) { setWaiting(false); setFailed(false); }
    else if (next.loginState !== "pending") { setWaiting(false); setFailed(next.loginState !== "cancelled"); }
  });

  const start = async () => {
    if (waiting || busy) return;
    const request = ++generation.current;
    setWaiting(true);
    setFailed(false);
    setCapture({});
    setCopyFallback(false);
    try {
      const result = await api(path, { method: "POST", body: JSON.stringify({ device: phone }) });
      if (request !== generation.current) return;
      setCapture(result);
      if (external) {
        const opened = await window.ogb?.openEngineSignIn?.(instance.instanceId);
        if (request !== generation.current) return;
        if (opened === "copied" || opened === undefined) {
          setCopyFallback(true);
          if (opened === undefined && instance.install?.signInCommand) {
            await navigator.clipboard?.writeText(instance.install.signInCommand).catch(() => {});
          }
        }
      }
    } catch {
      if (request !== generation.current) return;
      setWaiting(false);
      setFailed(true);
      void api(path, { method: "DELETE" }).catch(() => {});
    }
  };
  const cancel = async () => {
    if (busy) return;
    const request = ++generation.current;
    setBusy(true);
    try {
      await api(path, { method: "DELETE" });
      if (request !== generation.current) return;
      setWaiting(false);
      setCapture({});
    } catch { if (request === generation.current) setFailed(true); }
    finally { if (request === generation.current) setBusy(false); }
  };

  if (connected) return <span className="text-[12px] text-ink-secondary">{t("connections.connected")}</span>;
  if (computerOnly) return <span className="break-keep text-[12px] text-ink-secondary">{t("engines.signInFromComputer")}</span>;
  return (
    <div aria-live="polite" className="flex min-w-0 flex-col items-end gap-1.5 break-keep text-[12px] text-ink-secondary">
      {waiting ? <>
        <span>{copyFallback ? t("engine.pasteAndEnter") : capture.code ? t("engines.enterCode") : t("engines.finishInBrowser")}</span>
        {copyFallback && <code className="select-all break-all font-mono text-ink">{instance.install?.signInCommand}</code>}
        {capture.code && <code className="select-all break-all font-mono text-[14px] text-ink">{capture.code}</code>}
        <div className="flex flex-wrap justify-end gap-3">
          {capture.url && <a href={capture.url} target="_blank" rel="noreferrer" className="text-ink underline">{deviceFlow ? t("engines.openLink") : t("engines.openAgain")}</a>}
          <button type="button" onClick={() => void cancel()} disabled={busy} className="text-ink underline disabled:opacity-50">{t("engines.cancel")}</button>
        </div>
      </> : <button type="button" onClick={() => void start()} className="rounded-lg bg-control px-3 py-2 font-medium text-ink hover:bg-raised-hover">{t("engines.signIn")}</button>}
      {failed && <span>{t("engines.didntFinish")}</span>}
    </div>
  );
}

export function EngineSetup({
  instance,
  className,
  intent = "cloud",
  signIn = false,
}: {
  instance: InstanceInfo;
  className?: string;
  /** `inject` installs the CLI but deliberately skips cloud sign-in. */
  intent?: "cloud" | "inject";
  /** Force the sign-in card when the snapshot has no `authenticated` field. */
  signIn?: boolean;
}) {
  const { t } = useI18n();
  const install = instance.install;
  const installCommand = installCommandFor(install);
  const signInCommand = install?.signInCommand;
  const signInOnly = intent === "cloud" && (needsSignIn(instance) || (signIn && !needsCli(instance)));
  const command = signInOnly ? signInCommand : installCommand;
  const oneClick = signInOnly && Boolean(install?.login || instance.driverKind === "antigravityAgent");
  const title = signInOnly
    ? t("engine.signInTo", { name: instance.displayName })
    : t("engine.installName", { name: instance.displayName });
  const description = oneClick
    ? t("engines.notSignedIn")
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
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
          {signInOnly ? <LogIn size={14} /> : <Download size={14} />}
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{title}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{description}</p>
        </div>
      </div>

      {oneClick ? (
        <div className="mt-3 flex justify-end"><EngineSignIn instance={instance} /></div>
      ) : command ? (
        <CommandRow command={command} signInInstanceId={signInOnly ? instance.instanceId : undefined} installInstanceId={signInOnly ? undefined : instance.instanceId} installOnly={intent === "inject"} signsIn={intent !== "inject" && installSignsIn(install)} docsUrl={install.docsUrl} actionLabel={signInOnly ? t("engine.openSignIn") : t("engine.openInstall")} />
      ) : (
        <p className="mt-3 rounded-lg bg-inset px-2.5 py-2 text-[12px] leading-relaxed text-ink-secondary">
          {t("engine.noInstaller")}
        </p>
      )}

      {/* needsNode is engine-wide; only show it when this machine's command is npm. */}
      {!signInOnly && install.needsNode && (installCommand?.includes("npm") ?? true) && (
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
