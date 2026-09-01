// Locale detection, persistence, and phrase lookup. English and Korean are
// first-class; anything else falls back to English. First launch follows the
// OS. An explicit Settings choice is remembered and stops following the OS.
// User messages, bot output, filenames, and transcripts never enter t().
import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { catalogs, type MessageKey } from "./i18n-catalog";
export type { MessageKey };

export const LOCALE_IDS = ["en", "ko"] as const;
export type LocaleId = (typeof LOCALE_IDS)[number];
export const LOCALE_PREFERENCES = ["system", "en", "ko"] as const;
export type LocalePreference = (typeof LOCALE_PREFERENCES)[number];

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export const DEFAULT_LOCALE: LocaleId = "en";
export const DEFAULT_PREFERENCE: LocalePreference = "system";

const KEY = "omb-locale";

let currentLocale: LocaleId = DEFAULT_LOCALE;

function isLocaleId(value: string | null | undefined): value is LocaleId {
  return value === "en" || value === "ko";
}

function isPreference(value: string | null | undefined): value is LocalePreference {
  return value === "system" || value === "en" || value === "ko";
}

function getStore(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

/** Map an OS/BCP-47 tag onto the two product languages. Unknown tags → English. */
export function detectLocale(tag: string | null | undefined): LocaleId {
  const lower = String(tag ?? "").trim().toLowerCase().replaceAll("_", "-");
  if (lower === "ko" || lower.startsWith("ko-") || lower === "kor" || lower.startsWith("kor-")) {
    return "ko";
  }
  return "en";
}

export function localeTag(id: LocaleId): string {
  return id === "ko" ? "ko" : "en";
}

export function readOsLocaleTag(): string {
  try {
    // Host bridge is optional; a browser tab or unit test has no ogb.
    const fromHost = window.ogb?.getLocale?.();
    if (fromHost && fromHost.trim()) return fromHost;
  } catch {
    /* no bridge */
  }
  try {
    if (navigator.language) return navigator.language;
  } catch {
    /* navigator blocked */
  }
  return "en";
}

export function readPreference(): LocalePreference {
  try {
    const stored = getStore()?.getItem(KEY);
    if (isPreference(stored)) return stored;
  } catch {
    /* quota / private mode */
  }
  try {
    const fromHost = window.ogb?.getLocalePreference?.();
    if (isPreference(fromHost)) return fromHost;
  } catch {
    /* no bridge */
  }
  return DEFAULT_PREFERENCE;
}

export function resolveLocale(preference: LocalePreference, osTag: string = readOsLocaleTag()): LocaleId {
  if (isLocaleId(preference)) return preference;
  return detectLocale(osTag);
}

export function activeLocale(): LocaleId {
  return currentLocale;
}

/**
 * Stamp <html lang> and remember the resolved locale for non-React helpers.
 * Called before the first paint (main.tsx) and again on every Settings change.
 */
export function applyLocale(id: LocaleId): void {
  currentLocale = id;
  try {
    document.documentElement.lang = localeTag(id);
    document.documentElement.dataset.locale = id;
  } catch {
    /* no document in unit tests or the Electron main process */
  }
}

export function persistPreference(preference: LocalePreference): LocaleId {
  const locale = resolveLocale(preference);
  try {
    getStore()?.setItem(KEY, preference);
  } catch {
    /* quota / private mode — still apply for this session */
  }
  try {
    void window.ogb?.setLocalePreference?.(preference)?.catch(() => undefined);
  } catch {
    /* no bridge */
  }
  applyLocale(locale);
  return locale;
}

export function translate(locale: LocaleId, key: MessageKey, vars?: Record<string, string | number>): string {
  const table = catalogs[locale] ?? catalogs.en;
  let phrase: string = table[key] ?? catalogs.en[key];
  if (!vars) return phrase;
  for (const [name, value] of Object.entries(vars)) {
    phrase = phrase.replaceAll(`{${name}}`, String(value));
  }
  return phrase;
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(currentLocale, key, vars);
}

type I18nValue = {
  locale: LocaleId;
  preference: LocalePreference;
  t: Translate;
  setPreference: (preference: LocalePreference) => void;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LocalePreference>(() => readPreference());
  const locale = useMemo(() => resolveLocale(preference), [preference]);
  useEffect(() => {
    applyLocale(locale);
  }, [locale]);
  const value = useMemo<I18nValue>(() => ({
    locale,
    preference,
    t: (key, vars) => translate(locale, key, vars),
    setPreference: (next) => {
      persistPreference(next);
      setPreferenceState(next);
    },
  }), [locale, preference]);
  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  return {
    locale: currentLocale,
    preference: readPreference(),
    t: (key, vars) => translate(currentLocale, key, vars),
    setPreference: persistPreference,
  };
}
