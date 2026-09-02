import type { MessageKey } from "./i18n-catalog";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function catalogModelLabel(
  instance: { models: { options: readonly { id: string; label: string }[] } } | undefined,
  model: string,
): string {
  return instance?.models.options.find((option) => option.id === model)?.label ?? model;
}

/** Chip copy is the live engine/model. Automatic is a picker mode, not a name. */
export function modelChipText(input: {
  instance?: { displayName: string; models: { options: readonly { id: string; label: string }[] } };
  model: string;
}): string {
  return catalogModelLabel(input.instance, input.model);
}

export function modelChipTitle(
  input: {
    mode?: "automatic" | "pinned";
    instance?: { displayName: string; models: { options: readonly { id: string; label: string }[] } };
    model: string;
  },
  t: Translate,
): string {
  const live = modelChipText(input);
  if (input.mode === "automatic") {
    return t("model.automaticTitle", {
      name: input.instance ? live : t("model.unresolved"),
    });
  }
  if (input.instance) {
    return t("model.pinnedTitle", { engine: input.instance.displayName, model: live });
  }
  return live;
}

export function engineBadgeText(
  snapshot: { version?: string | null },
  kind: "not-installed" | "sign-in" | "ready",
  t: Translate,
): string {
  if (kind === "not-installed") return t("model.notInstalled");
  if (kind === "sign-in") return t("model.signInRequired");
  const version = snapshot.version?.trim();
  if (version) return t("model.cliVersion", { version });
  return t("onboarding.ready");
}
