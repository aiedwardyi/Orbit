import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-catalog";
import { Card } from "./SettingsPrimitives";

export function KeyboardShortcuts() {
  const { t } = useI18n();
  const mac = /Mac/i.test(globalThis.navigator?.platform ?? "");
  const mod = mac ? "Cmd" : "Ctrl";
  const alt = mac ? "Option" : "Alt";
  const terminal: Array<[MessageKey, string[]]> = window.ogb?.terminal ? [["shortcuts.terminal", [mod, "`"]]] : [];
  const groups: Array<{ title: MessageKey; rows: Array<[MessageKey, string[]]> }> = [
    { title: "shortcuts.navigation", rows: [
      ["shortcuts.themes", [alt, "T"]],
      ["shortcuts.usage", [alt, "U"]],
      ["shortcuts.usageRefresh", [alt, "R"]],
    ] },
    { title: "shortcuts.chat", rows: [
      ["shortcuts.model", [alt, "M"]],
      ...terminal,
    ] },
  ];
  return (
    <>
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t("shortcuts.help")}</p>
      {groups.map(({ title, rows }) => (
        <Card key={title} title={t(title)}>
          <dl className="divide-y divide-hairline/40">
            {rows.map(([label, keys]) => (
              <div key={label} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5 first:pt-0 last:pb-0">
                <dt className="text-[13px] text-ink">{t(label)}</dt>
                <dd className="flex shrink-0 items-center gap-1" aria-label={keys.join(" + ")}>
                  {keys.map((key) => <kbd key={key} className="min-w-7 rounded border border-hairline bg-control px-2 py-1 text-center font-mono text-[12px] text-ink-secondary">{key}</kbd>)}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      ))}
    </>
  );
}
