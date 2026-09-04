// App settings, as a real modal with sections rather than one long panel.
// Per-bot settings (persona, model, computer) stay in SettingsPanel — this
// is the stuff shared by every bot: who you are, your keys, and the
// machine your bots can borrow.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Coins, Globe, KeyRound, Monitor, Search, Smartphone, Terminal, Trash2, User, X } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { builtInBrowserEnabled, showToolCallsEnabled, skillRecorderEnabled } from "@/lib/feature-flags";
import {
  showSettingsAdvancedSection,
  showSettingsEnginesNav,
  showSettingsMoreServicesSection,
  showSettingsSearch,
} from "@/lib/friends-chrome";
import {
  friendsSettingsNavVisible,
  resolvedAppSettingsSection,
  showSettingsAdvancedControls,
  showSettingsMoreServices,
} from "@/lib/settings-chrome";
import { ApiKeyRow, VpsConnection } from "./ApiKeys";
import { useUpdaterState } from "@/lib/updater";
import { EnginesSettings } from "./EnginesSettings";
import { LocalComputerSection } from "./LocalComputerSection";
import { ProfileFields } from "./ProfileFields";
import { Card } from "./SettingsPrimitives";
import { UsageSection } from "./UsageSection";
import { SkinPicker } from "./SkinPicker";
import { LanguagePicker } from "./LanguagePicker";
import { useI18n } from "@/lib/i18n";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { phoneSettingsAvailable } from "@/lib/phone-availability";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { TranscriptionSettings } from "./TranscriptionSettings";
import { cn } from "@/lib/cn";

const SECTIONS: Array<{
  id: AppSettingsSection;
  icon: typeof User;
}> = [
  { id: "general", icon: User },
  { id: "connections", icon: KeyRound },
  { id: "engines", icon: Terminal },
  { id: "companion", icon: Smartphone },
  { id: "computer", icon: Monitor },
  { id: "usage", icon: Coins },
];

const SECTION_KEY = {
  general: "settings.section.general",
  connections: "settings.section.connections",
  engines: "settings.section.engines",
  companion: "settings.section.companion",
  computer: "settings.section.computer",
  usage: "settings.section.usage",
} as const;

function sectionNavVisible(
  section: (typeof SECTIONS)[number],
  query: string,
  phoneAvailable: boolean,
): boolean {
  return friendsSettingsNavVisible(section.id, query, { phoneAvailable });
}

function UpdatesRow() {
  const { t } = useI18n();
  const s = useUpdaterState();
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  const label =
    s?.status === "checking"
      ? t("settings.updates.checking")
      : s?.status === "available"
        ? t("settings.updates.available", { version: s.version ?? "" })
        : s?.status === "downloading"
          ? t("settings.updates.downloading", { percent: Math.round(s.percent ?? 0) })
          : s?.status === "downloaded"
            ? t("settings.updates.ready", { version: s.version ?? "" })
            : s?.status === "error"
              ? t("settings.updates.error", { message: s.message ?? t("settings.updates.unknownError") })
              : t("settings.updates.latest");
  return (
    <Card title={t("settings.updates.title")} subtitle={label}>
      <button
        onClick={() => {
          if (s?.status === "available") return void updater.download();
          if (s?.status === "downloaded") return void updater.install();
          void updater.check();
        }}
        disabled={s?.status === "checking" || s?.status === "downloading"}
        className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
      >
        {s?.status === "available"
          ? t("settings.updates.download")
          : s?.status === "downloaded"
            ? t("settings.updates.restart")
            : t("settings.updates.check")}
      </button>
    </Card>
  );
}

/** Optional usage analytics. Naming what is sent
 * matters more than the switch: people who cannot see the scope assume the
 * worst, and the worst — conversation text — is exactly what this never
 * sends (autocapture is off; see lib/analytics.ts). */
function AnalyticsRow() {
  const { t } = useI18n();
  const [on, setOn] = useState(analyticsEnabled);
  return (
    <Card
      title={t("settings.analytics.title")}
      subtitle={t("settings.analytics.subtitle")}
    >
      <button
        role="switch"
        aria-checked={on}
        aria-label={t("settings.analytics.aria")}
        onClick={() => {
          const next = !on;
          setAnalyticsEnabled(next);
          setOn(next);
        }}
        className={cnSwitch(on)}
      >
        <span className={cnKnob(on)} />
      </button>
    </Card>
  );
}

function ToolCallsRow() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const enabled = showToolCallsEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { showToolCalls: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.toolCalls.saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={t("settings.toolCalls.title")}
      subtitle={t("settings.toolCalls.subtitle")}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("settings.toolCalls.toggle")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("settings.toolCalls.help")}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={t("settings.toolCalls.aria")}
          disabled={saving}
          onClick={() => void toggle()}
          className={`${cnSwitch(enabled)} disabled:cursor-wait disabled:opacity-50`}
        >
          <span className={cnKnob(enabled)} />
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

function ExperimentalFeaturesRow() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const skillRecorder = skillRecorderEnabled(state.config);
  const browser = builtInBrowserEnabled(state.config);
  const desktopBrowser = Boolean(window.ogb?.browser);
  const [saving, setSaving] = useState<"skillRecorder" | "browser" | null>(null);
  const [error, setError] = useState("");

  const toggle = async (feature: "skillRecorder" | "browser", next: boolean) => {
    if (saving) return;
    setSaving(feature);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { [feature]: next } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.experimental.saveError"));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card
      title={t("settings.experimental.title")}
      subtitle={t("settings.experimental.subtitle")}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("settings.experimental.skill")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("settings.experimental.skillHelp")}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={skillRecorder}
          aria-label={t("settings.experimental.skillAria")}
          disabled={saving !== null}
          onClick={() => void toggle("skillRecorder", !skillRecorder)}
          className={`${cnSwitch(skillRecorder)} disabled:cursor-wait disabled:opacity-50`}
        >
          <span className={cnKnob(skillRecorder)} />
        </button>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/30 pt-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("settings.experimental.browser")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {desktopBrowser
              ? t("settings.experimental.browserHelp")
              : t("settings.experimental.browserNeedsDesktop")}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={browser}
          aria-label={t("settings.experimental.browserAria")}
          disabled={saving !== null || (!browser && !desktopBrowser)}
          onClick={() => void toggle("browser", !browser)}
          className={`${cnSwitch(browser)} disabled:cursor-wait disabled:opacity-50`}
        >
          <span className={cnKnob(browser)} />
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

/** Named browser sessions: rename or delete; deleting wipes that session's
 * logins, storage and cache and sends any bot on it back to its own. */
function BrowserProfilesRow() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const profiles = state.config?.browserProfiles ?? [];
  const bridge = window.ogb?.browser;
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState("");
  if (!builtInBrowserEnabled(state.config) || !bridge) return null;

  const save = async (next: typeof profiles, then?: () => Promise<void>) => {
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ browserProfiles: next }) });
      dispatch({ type: "configStatus", config });
      await then?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.browserProfiles.saveError"));
    } finally {
      setBusy(null);
      setRenaming(null);
    }
  };
  const remove = (id: string) => {
    if (busy) return;
    setBusy(id);
    setError("");
    void save(
      profiles.filter((profile) => profile.id !== id),
      async () => {
        // bots pointed at it fall back to their own session server-side; the
        // surface drops its views and wipes the partition's data
        for (const bot of state.bots) {
          if (bot.browserProfile === id) dispatch({ type: "updateBot", botId: bot.id, patch: { browserProfile: null } });
        }
        await bridge.forgetProfile?.(id);
      },
    );
  };
  const rename = () => {
    if (!renaming || busy) return;
    const name = renaming.name.trim();
    if (!name) return;
    setBusy(renaming.id);
    setError("");
    void save(profiles.map((profile) => (profile.id === renaming.id ? { ...profile, name } : profile)));
  };
  const usersOf = (id: string) => state.bots.filter((bot) => !bot.hidden && bot.browserProfile === id).map((bot) => bot.name);

  return (
    <Card
      title={t("settings.browserProfiles.title")}
      subtitle={t("settings.browserProfiles.subtitle")}
    >
      {profiles.length === 0 ? (
        <div className="text-[13px] text-ink-secondary">{t("settings.browserProfiles.empty")}</div>
      ) : (
        <div className="flex flex-col divide-y divide-hairline/30">
          {profiles.map((profile) => {
            const users = usersOf(profile.id);
            const editing = renaming?.id === profile.id;
            return (
              <div key={profile.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Globe size={14} className="shrink-0 text-ink-secondary" />
                  {editing ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        rename();
                      }}
                    >
                      <input
                        autoFocus
                        value={renaming.name}
                        onChange={(event) => setRenaming({ id: profile.id, name: event.target.value })}
                        maxLength={40}
                        className="rounded-md bg-inset px-2 py-1 text-[13px] text-ink outline-none"
                        aria-label={t("settings.browserProfiles.nameAria")}
                      />
                      <button type="submit" disabled={busy !== null} className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-ink disabled:opacity-50">
                        {t("settings.browserProfiles.save")}
                      </button>
                      <button type="button" onClick={() => setRenaming(null)} className="text-[12px] text-ink-secondary hover:text-ink">
                        {t("settings.browserProfiles.cancel")}
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRenaming({ id: profile.id, name: profile.name })}
                      className="truncate text-left text-[14px] font-medium text-ink hover:underline"
                      title={t("settings.browserProfiles.rename")}
                    >
                      {profile.name}
                    </button>
                  )}
                  <span className="truncate text-[12px] text-ink-secondary">
                    {users.length ? t("settings.browserProfiles.inUse", { names: users.join(", ") }) : t("settings.browserProfiles.notInUse")}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => remove(profile.id)}
                  disabled={busy !== null}
                  className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"
                  title={t("settings.browserProfiles.deleteTitle")}
                >
                  <Trash2 size={13} /> {t("settings.browserProfiles.delete")}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;

/** Writes a redacted diagnostics file to a location the user picks. The
 * report holds versions, configured-or-not booleans and the server.log tail —
 * never credential values (the desktop shell does not read secret fields). */
function DiagnosticsRow() {
  const { t } = useI18n();
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const exportDiagnostics = async () => {
    if (!window.ogb?.exportDiagnostics || exporting) return;
    setExporting(true);
    setResult(null);
    try {
      const path = await window.ogb.exportDiagnostics();
      if (path) setResult({ kind: "success", message: t("settings.diagnostics.saved", { path }) });
    } catch (e) {
      setResult({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card
      title={t("settings.diagnostics.title")}
      subtitle={t("settings.diagnostics.subtitle")}
    >
      <div className="flex min-w-0 flex-col items-end gap-2">
        <button
          onClick={() => void exportDiagnostics()}
          disabled={exporting}
          aria-label={t("settings.diagnostics.exportAria")}
          className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
        >
          {exporting ? t("settings.diagnostics.exporting") : t("settings.diagnostics.export")}
        </button>
        {result ? (
          <span
            role={result.kind === "error" ? "alert" : "status"}
            className={`max-w-64 break-all text-right text-[12px] ${result.kind === "error" ? "text-danger" : "text-success"}`}
          >
            {result.message}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

export function SettingsModal({
  defaultAdvancedOpen = false,
  defaultMoreServicesOpen = false,
}: {
  /** Start with Advanced expanded (tests). */
  defaultAdvancedOpen?: boolean;
  /** Start with More services expanded (tests). */
  defaultMoreServicesOpen?: boolean;
}) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const section = resolvedAppSettingsSection(state.appSettingsSection);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(defaultAdvancedOpen);
  const [moreServicesOpen, setMoreServicesOpen] = useState(defaultMoreServicesOpen);
  const q = query.trim().toLowerCase();
  const phoneAvailable = phoneSettingsAvailable(capabilities.host);
  const advancedShown = showSettingsAdvancedControls(advancedOpen);
  const moreServicesShown = showSettingsMoreServices(moreServicesOpen);
  const visibleSections = SECTIONS.filter((entry) => sectionNavVisible(entry, q, phoneAvailable));

  useEffect(() => {
    const visible = SECTIONS.filter((entry) => sectionNavVisible(entry, q, phoneAvailable));
    if (visible.some((entry) => entry.id === section)) return;
    const first = visible[0];
    if (first) dispatch({ type: "toggleAppSettings", open: true, section: first.id });
  }, [dispatch, phoneAvailable, q, section]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className="flex h-[560px] w-full max-w-[860px] overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none"
      >
        {/* section nav */}
        <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 border-r border-hairline/40 p-3">
          <div id="app-settings-title" className="px-2 pb-2 pt-1 text-[15px] font-semibold text-ink">
            {t("settings.title")}
          </div>
          {showSettingsSearch() && (
          <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-control/70 px-2.5 py-1.5">
            <Search size={14} className="shrink-0 text-ink-secondary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                if (query) setQuery("");
                else dispatch({ type: "toggleAppSettings", open: false });
              }}
              placeholder={t("settings.search")}
              aria-label={t("settings.searchAria")}
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
          )}
          {visibleSections.length === 0 && (
            <div className="px-2.5 py-4 text-[12.5px] leading-relaxed text-ink-secondary">
              {t("settings.noMatch", { query: query.trim() })}
            </div>
          )}
          {visibleSections.map(({ id, icon: Icon }) => (
            <button
              key={id}
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px]",
                section === id ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
              )}
            >
              <Icon size={15} />
              {t(SECTION_KEY[id])}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-[15px] font-semibold text-ink">
              {t(SECTION_KEY[section])}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label={t("settings.close")}
              className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {section === "general" && (
              <>
                <LanguagePicker />
                <Card title={t("settings.profile.title")} subtitle={t("settings.profile.subtitle")}>
                  <ProfileFields />
                </Card>
                <Card title={t("settings.skin.title")} subtitle={t("settings.skin.subtitle")}>
                  <SkinPicker />
                </Card>
                <ToolCallsRow />
                <BrowserProfilesRow />
                <UpdatesRow />
                <AnalyticsRow />
                {showSettingsAdvancedSection() && (
                  <>
                <button
                  type="button"
                  aria-expanded={advancedShown}
                  onClick={() => setAdvancedOpen((open) => !open)}
                  className="flex w-full items-center justify-between rounded-xl border border-hairline/40 bg-card px-4 py-3 text-left hover:bg-control/60"
                >
                  <span>
                    <span className="block text-[14px] font-medium text-ink">{t("settings.advanced.title")}</span>
                    <span className="mt-0.5 block text-[12px] text-ink-secondary">
                      {t("settings.advanced.subtitle")}
                    </span>
                  </span>
                  <ChevronDown
                    size={16}
                    className={cn("text-ink-secondary transition-transform", advancedShown && "rotate-180")}
                  />
                </button>
                {advancedShown && (
                  <div data-settings-advanced className="flex flex-col gap-4">
                    <LocalComputerSection />
                    <Card title={t("settings.channelTurns.title")} subtitle={t("settings.channelTurns.subtitle")}>
                      <RoomTurnTimeoutSettings />
                    </Card>
                    <ExperimentalFeaturesRow />
                    <DiagnosticsRow />
                  </div>
                )}
                  </>
                )}
              </>
            )}

            {section === "connections" && (
              <Card
                title={t("settings.connections.title")}
                subtitle={t("settings.connections.subtitle")}
              >
                <div className="flex flex-col gap-4">
                  {state.config?.composio.mode === "managed" ? (
                    <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
                      {t("settings.connections.ready")}
                    </div>
                  ) : null}
                  <EnginesSettings />
                  <ApiKeyRow section="gemini" />
                  <ApiKeyRow section="opencodeGo" />
                  {showSettingsMoreServicesSection() && (
                    <>
                  <button
                    type="button"
                    aria-expanded={moreServicesShown}
                    onClick={() => setMoreServicesOpen((open) => !open)}
                    className="flex w-full items-center justify-between rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-left hover:bg-control/60"
                  >
                    <span className="text-[13px] font-medium text-ink">{t("settings.connections.moreServices")}</span>
                    <ChevronDown
                      size={16}
                      className={cn("text-ink-secondary transition-transform", moreServicesShown && "rotate-180")}
                    />
                  </button>
                  {moreServicesShown && (
                    <div data-settings-more-services className="flex flex-col gap-4">
                      <TranscriptionSettings />
                      <ApiKeyRow section="box" />
                      <VpsConnection />
                      <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
                        <summary className="cursor-pointer text-[13px] text-ink-secondary">{t("settings.connections.selfHost")}</summary>
                        <div className="mt-3">
                          <ApiKeyRow section="composio" />
                        </div>
                      </details>
                    </div>
                  )}
                    </>
                  )}
                </div>
              </Card>
            )}

            {showSettingsEnginesNav() && section === "engines" && (
              <Card title={t("settings.engines.title")} subtitle={t("settings.engines.subtitle")}>
                <EnginesSettings />
              </Card>
            )}

            {showSettingsAdvancedSection() && section === "computer" && <LocalComputerSection />}

            {section === "usage" && <UsageSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
