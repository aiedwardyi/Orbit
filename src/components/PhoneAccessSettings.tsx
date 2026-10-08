import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { localeTag, useI18n, type MessageKey } from "@/lib/i18n";
import { api } from "@/state/store";
import { Section } from "./SettingsPrimitives";

type RelayState = "off" | "enrolling" | "certifying" | "connected" | "reconnecting" | "rejected" | "cert-error";
type RelayProblem = "superseded" | "revoked" | "ticket-expired" | "unknown-certificate";

export interface RelayStatus {
  configured: boolean;
  enabled: boolean;
  state: RelayState;
  host: string | null;
  relayRttMs: number | null;
  certNotAfter: number | null;
  lastError: string | null;
  nextRetryAt: number | null;
  problem: RelayProblem | null;
}

interface Phone {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

interface Pairing {
  url: string;
  code: string;
  expiresAt: number;
  /** Phones paired before this code, so a new one can be noticed. */
  known: string[];
}

const STATUS_POLL_MS = 3_000;
const PAIRING_POLL_MS = 2_000;

const PROBLEM = {
  superseded: "settings.phoneAccess.problem.superseded",
  revoked: "settings.phoneAccess.problem.revoked",
  "ticket-expired": "settings.phoneAccess.problem.ticketExpired",
  "unknown-certificate": "settings.phoneAccess.problem.unknownCertificate",
} satisfies Record<RelayProblem, MessageKey>;

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;
const button = "rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-control/70 disabled:cursor-not-allowed disabled:opacity-50";

function countdown(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Phone access from anywhere through the relay. Absent unless this PC has a relay configured. */
export function PhoneAccessSettings({ request = api }: { request?: typeof api }) {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [phones, setPhones] = useState<Phone[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPhones = useCallback(
    () =>
      request("/api/phone/devices").then((body: { phones: Phone[] }) => {
        setPhones(body.phones);
        return body.phones;
      }),
    [request],
  );

  useEffect(() => {
    let live = true;
    const load = () =>
      request("/api/phone-relay/status")
        .then((body: RelayStatus) => {
          if (!live) return;
          setStatus(body);
          setNow(Date.now());
        })
        .catch(() => {});
    void load();
    const timer = window.setInterval(load, STATUS_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [request]);

  const enabled = status?.enabled === true;
  useEffect(() => {
    if (enabled) void loadPhones().catch(() => {});
  }, [enabled, loadPhones]);

  // While a code is up: tick its countdown and notice the phone that used it.
  useEffect(() => {
    if (!pairing) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const poll = window.setInterval(() => {
      void loadPhones()
        .then((list) => {
          const added = list.find((phone) => !pairing.known.includes(phone.id));
          if (!added) return;
          setPairing(null);
          setPaired(added.name);
        })
        .catch(() => {});
    }, PAIRING_POLL_MS);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [pairing, loadPhones]);

  // While a retry is scheduled: tick its countdown.
  const retrying = status?.state === "reconnecting" && status.nextRetryAt !== null;
  useEffect(() => {
    if (!retrying) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, [retrying]);

  if (!status?.configured) return null;

  const run = async (work: () => Promise<void>, failure: (cause: unknown) => string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggle = () =>
    run(
      async () => setStatus(await request("/api/phone-relay", { method: "PUT", body: JSON.stringify({ enabled: !enabled }) })),
      () => t("settings.phoneAccess.saveError"),
    );
  const join = () =>
    run(
      async () => {
        setStatus(await request("/api/phone-relay/enroll", { method: "POST", body: JSON.stringify({ invite: invite.trim() }) }));
        setInvite("");
      },
      (cause) => t("settings.phoneAccess.joinError", { message: cause instanceof Error ? cause.message : String(cause) }),
    );
  const addPhone = () =>
    run(
      async () => {
        const body: Omit<Pairing, "known"> = await request("/api/phone/pairing", { method: "POST" });
        setPaired(null);
        setNow(Date.now());
        setPairing({ ...body, known: phones.map((phone) => phone.id) });
      },
      () => t("settings.phoneAccess.pairError"),
    );
  const cancel = () => {
    setPairing(null);
    void request("/api/phone/pairing", { method: "DELETE" }).catch(() => {});
  };
  const remove = (phone: Phone) =>
    run(
      async () => {
        await request(`/api/phone/devices/${encodeURIComponent(phone.id)}`, { method: "DELETE" });
        setPhones((list) => list.filter((candidate) => candidate.id !== phone.id));
      },
      () => t("settings.phoneAccess.removeError"),
    );

  const tag = localeTag(locale);
  const day = (ms: number) => new Date(ms).toLocaleDateString(tag, { month: "short", day: "numeric" });
  const retryIn = status.nextRetryAt ? Math.max(1, Math.ceil((status.nextRetryAt - now) / 1000)) : null;
  const stateText =
    status.state === "reconnecting"
      ? retryIn
        ? t("settings.phoneAccess.state.retrying", { seconds: retryIn })
        : t("settings.phoneAccess.state.connecting")
      : status.state === "cert-error"
        ? t("settings.phoneAccess.state.certError")
        : t(`settings.phoneAccess.state.${status.state}`);
  const needsInvite = enabled && (status.state === "enrolling" || status.problem === "revoked" || status.problem === "ticket-expired");
  const left = pairing ? Math.max(0, pairing.expiresAt - now) : 0;

  return (
    <Section title={t("settings.phoneAccess.title")} subtitle={t("settings.phoneAccess.help")}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <div data-phone-access-state={status.state} className="min-w-0 text-[13px] leading-relaxed text-ink">
            {stateText}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t("settings.phoneAccess.toggle")}
            disabled={busy}
            onClick={() => void toggle()}
            className={cnSwitch(enabled)}
          >
            <span className={cnKnob(enabled)} />
          </button>
        </div>

        {enabled && !status.problem && status.lastError ? (
          <p data-phone-access-error className="-mt-2 break-words text-[12px] text-ink-secondary">
            {status.state === "connected" ? t("settings.phoneAccess.renewalError", { message: status.lastError }) : status.lastError}
          </p>
        ) : null}

        {enabled && status.problem ? (
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] leading-relaxed text-danger">
            {t(PROBLEM[status.problem])}
          </div>
        ) : null}

        {needsInvite ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (invite.trim()) void join();
            }}
          >
            <input
              value={invite}
              onChange={(event) => setInvite(event.target.value)}
              aria-label={t("settings.phoneAccess.invite")}
              placeholder={t("settings.phoneAccess.invite")}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-hairline bg-inset px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-accent"
            />
            <button type="submit" disabled={busy || !invite.trim()} className={button}>
              {t("settings.phoneAccess.join")}
            </button>
          </form>
        ) : null}

        {enabled && status.state === "connected" && !pairing ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void addPhone()}
            className="self-start rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-50"
          >
            {t("settings.phoneAccess.addPhone")}
          </button>
        ) : null}

        {pairing ? (
          <div className="flex flex-col items-center rounded-xl bg-inset px-4 py-4 text-center">
            {left > 0 ? (
              <>
                <div className="rounded-2xl bg-white p-3" aria-label={t("settings.phoneAccess.qrLabel")}>
                  <QRCodeSVG value={pairing.url} size={168} level="M" bgColor="#ffffff" fgColor="#111111" />
                </div>
                <div data-pairing-code className="mt-3 font-mono text-[22px] tracking-[0.25em] text-ink">
                  {pairing.code}
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("settings.phoneAccess.scan")}</p>
                <p className="mt-1 text-[11.5px] text-ink-secondary">{t("settings.phoneAccess.expiresIn", { time: countdown(left) })}</p>
              </>
            ) : (
              <p className="text-[13px] text-ink-secondary">{t("settings.phoneAccess.expired")}</p>
            )}
            <div className="mt-3 flex gap-2">
              {left > 0 ? null : (
                <button type="button" disabled={busy} onClick={() => void addPhone()} className={button}>
                  {t("settings.phoneAccess.newCode")}
                </button>
              )}
              <button type="button" onClick={cancel} className={button}>
                {t("settings.phoneAccess.cancel")}
              </button>
            </div>
          </div>
        ) : null}

        {paired ? <p className="text-[12.5px] text-success">{t("settings.phoneAccess.paired", { name: paired })}</p> : null}
        {error ? (
          <p role="alert" className="text-[12.5px] text-danger">
            {error}
          </p>
        ) : null}

        {enabled ? (
          <div>
            <div className="text-[12px] font-medium text-ink-secondary">{t("settings.phoneAccess.phones")}</div>
            {phones.length ? (
              <ul className="mt-1 flex flex-col">
                {phones.map((phone) => (
                  <li key={phone.id} className="flex items-center gap-3 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-ink">{phone.name}</div>
                      <div className="text-[11.5px] text-ink-secondary">
                        {t("settings.phoneAccess.phoneMeta", { paired: day(phone.createdAt), seen: day(phone.lastSeenAt) })}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(phone)}
                      aria-label={t("settings.phoneAccess.removeAria", { name: phone.name })}
                      className={button}
                    >
                      {t("settings.phoneAccess.remove")}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-1 text-[12.5px] text-ink-secondary">{t("settings.phoneAccess.noPhones")}</div>
            )}
          </div>
        ) : null}

        {enabled && status.host ? (
          <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
            <summary className="cursor-pointer text-[13px] text-ink-secondary">{t("settings.advanced.title")}</summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
              <dt className="text-ink-secondary">{t("settings.phoneAccess.address")}</dt>
              <dd className="break-all font-mono text-ink">{status.host}</dd>
              {status.certNotAfter ? (
                <>
                  <dt className="text-ink-secondary">{t("settings.phoneAccess.certificate")}</dt>
                  <dd className="text-ink">{new Date(status.certNotAfter).toLocaleDateString(tag, { year: "numeric", month: "short", day: "numeric" })}</dd>
                </>
              ) : null}
              {status.relayRttMs !== null ? (
                <>
                  <dt className="text-ink-secondary">{t("settings.phoneAccess.latency")}</dt>
                  <dd className="text-ink">{status.relayRttMs} ms</dd>
                </>
              ) : null}
            </dl>
          </details>
        ) : null}
      </div>
    </Section>
  );
}
