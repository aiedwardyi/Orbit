import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-catalog";

export interface TeamPerson {
  id: string;
  name: string;
  online: boolean;
  lastSeen: number | null;
  pcs: { label: string; name: string; online: boolean }[];
  hours: number[];
  phone: { count: number; minutes: number }[];
}

export interface TeamView {
  now: number;
  days: string[];
  people: TeamPerson[];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];

function hoursText(hours: number): string {
  if (hours === 0) return "0h";
  if (hours < 0.1) return "<0.1h";
  return `${hours.toFixed(1).replace(/\.0$/, "")}h`;
}

function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function visitTime(minutes: number): string {
  return minutes === 0 ? "<1m" : minutesText(minutes);
}

// the relay counts a visit only on its start day, so one running past midnight has minutes but no count
function withVisit(day: { count: number; minutes: number }) {
  return day.count === 0 && day.minutes > 0 ? { ...day, count: 1 } : day;
}

function dayLabel(iso: string, locale: string) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1));
  const weekday = locale === "ko" ? WEEKDAYS_KO[date.getUTCDay()] : WEEKDAYS[date.getUTCDay()];
  const short = locale === "ko" ? `${month}월 ${day}일` : `${MONTHS[(month || 1) - 1]} ${day}`;
  return { full: `${weekday}, ${short}`, short };
}

function weekHours(people: TeamPerson[]): number {
  const sum = people.reduce((total, person) => total + person.hours.slice(-7).reduce((inner, hours) => inner + hours, 0), 0);
  return Math.round(sum * 10) / 10;
}

export function TeamSection({ stats }: { stats: TeamView }) {
  const { t, locale } = useI18n();
  const people = stats.people;
  if (people.length === 0) {
    return <p className="px-2 py-12 text-center text-[14px] text-ink-secondary">{t("team.empty")}</p>;
  }
  const online = people.filter((person) => person.online).length;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[14px] text-ink">{t("team.total", { hours: hoursText(weekHours(people)), online })}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {people.map((person) => (
          <PersonCard key={person.id} person={person} days={stats.days} now={stats.now} locale={locale} />
        ))}
      </div>
    </div>
  );
}

function PersonCard({ person, days, now, locale }: { person: TeamPerson; days: string[]; now: number; locale: string }) {
  const { t } = useI18n();
  const [tip, setTip] = useState<string | null>(null);
  const today = person.hours.at(-1) ?? 0;
  const status = person.online ? t("team.online") : seenText(person.lastSeen, now, t);
  const peak = person.hours.reduce((best, hours, index) => (hours > (person.hours[best] ?? 0) ? index : best), 0);
  const phoneDays = person.phone.map(withVisit);
  const phoneToday = phoneDays.at(-1) ?? { count: 0, minutes: 0 };
  const when = dayLabel(days[peak] ?? "", locale).full;
  const active = person.hours.filter((hours) => hours > 0).length;
  const letter = person.name.trim().slice(0, 1) || "?";
  return (
    <article className="min-w-0 rounded-xl bg-card p-4">
      <div className="mb-3 flex items-center gap-2.5">
        <div className="relative grid size-9 shrink-0 place-items-center rounded-full bg-control text-[15px] font-semibold text-ink">
          {letter}
          <span
            className={person.online ? "absolute -bottom-px -right-px size-2 rounded-full bg-success shadow-[0_0_0_2px_var(--color-card)]" : "absolute -bottom-px -right-px size-2 rounded-full border-[1.5px] border-ink-secondary shadow-[0_0_0_2px_var(--color-card)]"}
          />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium text-ink">{person.name}</div>
          <div className="text-[12px] text-ink-secondary">{status}</div>
        </div>
        <div className="ml-auto text-right" title={t("team.hoursOpen")}>
          <div className="text-[22px] font-semibold leading-tight tracking-tight text-ink tabular-nums">{hoursText(today)}</div>
          <div className="text-[12px] text-ink-secondary">{t("team.today")}</div>
        </div>
      </div>
      <div className="flex h-12 items-end gap-[3px] bg-[linear-gradient(to_top,var(--color-hairline),var(--color-hairline)_1px,transparent_1px)]">
        {person.hours.map((hours, index) => {
          const phone = phoneDays[index] ?? { count: 0, minutes: 0 };
          const label = dayLabel(days[index] ?? "", locale);
          const mobile = phone.count === 0 ? t("team.tipMobileNone") : t(phone.count === 1 ? "team.tipMobileOne" : "team.tipMobile", { n: phone.count, time: visitTime(phone.minutes) });
          const text = t("team.tip", { when: label.full, hours: hoursText(hours), mobile });
          const height = hours > 0 ? `${Math.max(10, Math.round(Math.min(1, hours / 12) * 100))}%` : "2px";
          return (
            <button
              key={days[index] ?? index}
              type="button"
              className="group relative h-full min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
              aria-label={text.replaceAll("\n", ", ")}
              onMouseEnter={() => setTip(text)}
              onMouseLeave={() => setTip(null)}
              onFocus={() => setTip(text)}
              onBlur={() => setTip(null)}
              onClick={() => setTip(text)}
            >
              <span
                className={hours > 0 ? "absolute inset-x-0 bottom-0 rounded-t-[2px] bg-accent group-hover:bg-accent-text group-focus-visible:bg-accent-text" : "absolute inset-x-0 bottom-0 bg-hairline group-hover:bg-ink-secondary"}
                style={{ height }}
              />
            </button>
          );
        })}
      </div>
      {tip && <p className="mt-1 whitespace-pre-line text-[12px] leading-snug text-ink">{tip}</p>}
      <div className="mt-1 flex justify-between text-[10px] text-ink-secondary">
        <span>{dayLabel(days[0] ?? "", locale).short}</span>
        <span>{dayLabel(days.at(-1) ?? "", locale).short}</span>
      </div>
      <div className="mt-2.5 flex justify-between gap-2 text-[12px] text-ink-secondary">
        <span className="tabular-nums">
          {phoneToday.count === 0 ? t("team.mobileNone") : t(phoneToday.count === 1 ? "team.mobileOne" : "team.mobileMany", { n: phoneToday.count, time: visitTime(phoneToday.minutes) })}
        </span>
        <span>{t(active === 1 ? "team.dayActive" : "team.daysActive", { n: active })}</span>
      </div>
      <p className="mt-1 text-[12px] text-ink-secondary">
        {t("team.busiest", { when, hours: hoursText(person.hours[peak] ?? 0) })}
      </p>
    </article>
  );
}

function seenText(lastSeen: number | null, now: number, t: (key: MessageKey, vars?: Record<string, string | number>) => string): string {
  if (lastSeen == null) return "-";
  const minutes = Math.floor(Math.max(0, now - lastSeen) / 60000);
  if (minutes < 1) return t("team.justNow");
  if (minutes < 60) return t("team.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("team.hoursAgo", { n: hours });
  return t("team.daysAgo", { n: Math.floor(hours / 24) });
}
