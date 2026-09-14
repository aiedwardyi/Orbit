import type { MessageKey } from "./i18n-catalog";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function catalogModelLabel(
  instance: { models: { options: readonly { id: string; label: string }[] } } | undefined,
  model: string,
): string {
  return instance?.models.options.find((option) => option.id === model)?.label ?? model;
}

/** Antigravity catalog labels carry the throttle tier in parens
 * ("Gemini 3.8 Flash (High)"); the header chip shows the base name and
 * renders effort separately, so the parenthesized tier is stripped here.
 * Non-tier parens ("Auto (recommended)") are kept verbatim. */
function stripTierParen(label: string): string {
  return label.replace(/\s+\((high|medium|low)\)\s*$/i, "").trim() || label;
}

/** Chip copy is the live engine/model. Automatic is a picker mode, not a name.
 * Strip ⟺ badge: the paren tier is stripped if and only if a separate
 * effort badge actually renders, so lone tier labels keep their only tier
 * signal verbatim. */
export function modelChipText(
  input: {
    instance?: { displayName: string; models: { options: readonly { id: string; label: string }[] } };
    model: string;
    effort?: string;
  },
  t: Translate,
): string {
  const raw = catalogModelLabel(input.instance, input.model);
  if (!raw) return t("model.unresolved");
  return displayedChipEffort(input.instance, input.model, input.effort)
    ? stripTierParen(raw)
    : raw;
}

type CatalogRef =
  | { models: { options: readonly { id: string; custom?: boolean }[] } }
  | undefined;

function tierSuffix(modelId: string): { stem: string; tier: string } | undefined {
  const match = modelId.match(/-(none|low|medium|high|xhigh|max)$/i);
  if (!match) return undefined;
  return { stem: modelId.slice(0, -match[0].length), tier: match[1]!.toLowerCase() };
}

/** Display-only effort for the header chip: an explicit selection.effort
 * wins; otherwise a tier parsed from the model-id suffix counts only when
 * a DISTINCT tier sibling exists — some shipped, non-custom option with the
 * same stem but a different id (a bare stem or another tier both count).
 * The model itself never counts, so lone suffixed options stay name-only.
 * Never touches selection state. */
export function displayedChipEffort(
  instance: CatalogRef,
  model: string,
  effort?: string,
): string | undefined {
  if (effort) return effort;
  const parsed = tierSuffix(model);
  if (!parsed || !parsed.stem) return undefined;
  const sibling = instance?.models.options.some((option) => {
    if (option.custom || option.id === model) return false;
    const other = tierSuffix(option.id);
    return (other ? other.stem : option.id) === parsed.stem;
  });
  return sibling ? parsed.tier : undefined;
}

/** Level ids to catalog keys, shared by the badge and the tooltip so both
 * localize together. Unknown ids pass through verbatim. */
const EFFORT_MESSAGE_KEYS = new Map<string, MessageKey>([
  ["none", "model.effortNone"],
  ["low", "model.effortLow"],
  ["medium", "model.effortMedium"],
  ["high", "model.effortHigh"],
  ["xhigh", "model.extraHigh"],
  ["max", "model.effortMax"],
]);

export function modelEffortLabel(effort: string, t: Translate): string {
  const key = EFFORT_MESSAGE_KEYS.get(effort);
  return key ? t(key) : effort;
}

/** Header-chip effort: the localized level with each word leading-capitalized,
 * so the one-line chip reads "Model · High" while the picker cells and status
 * line keep the catalog's lowercase "high". Cased ASCII only in practice —
 * non-cased locales (ko) pass through untouched. */
export function chipEffortLabel(effort: string, t: Translate): string {
  return modelEffortLabel(effort, t).replace(/(^|\s)(\S)/g, (_match, space: string, char: string) => space + char.toUpperCase());
}

export function modelChipTitle(
  input: {
    mode?: "automatic" | "pinned";
    instance?: { displayName: string; models: { options: readonly { id: string; label: string }[] } };
    model: string;
    effort?: string;
  },
  t: Translate,
): string {
  const live = modelChipText(input, t);
  const shown = displayedChipEffort(input.instance, input.model, input.effort);
  const named = shown ? `${live} · ${modelEffortLabel(shown, t)}` : live;
  if (input.mode === "automatic") {
    return t("model.automaticTitle", {
      name: input.instance ? named : t("model.unresolved"),
    });
  }
  if (input.instance) {
    return t("model.pinnedTitle", { engine: input.instance.displayName, model: named });
  }
  return named;
}

/** Family accents mirror ModelPicker.css's --picker-accent table. Kept here
 * (not read from the stylesheet) so the header chip can wear the same
 * color; the driver's family mapping matches ModelPicker's `families`. */
const FAMILY_ACCENTS = {
  gpt: "#3594ff",
  claude: "#ed6549",
  metamuse: "#43ce8b",
  gemini: "#aa7bfa",
  grok: "#8b929c",
} as const;

const DRIVER_FAMILIES = new Map<string, keyof typeof FAMILY_ACCENTS>([
  ["codex", "gpt"],
  ["grokAgent", "grok"],
  ["antigravityAgent", "gemini"],
  ["geminiAgent", "gemini"],
  ["claudeAgent", "claude"],
  ["museAgent", "metamuse"],
]);

export function modelFamilyAccent(driverKind?: string): string {
  return FAMILY_ACCENTS[DRIVER_FAMILIES.get(driverKind ?? "") ?? "grok"];
}

/** Short status for the model-picker engine pill. CLI --version belongs on Set CLI. */
export function engineBadgeText(
  _snapshot: { version?: string | null },
  kind: "not-installed" | "sign-in" | "ready",
  t: Translate,
): string {
  if (kind === "not-installed") return t("model.notInstalled");
  if (kind === "sign-in") return t("model.signInRequired");
  return t("onboarding.ready");
}
