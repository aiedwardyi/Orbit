import { useI18n } from "@/lib/i18n";

export function WorkingFolderField({ value, onChange, onSave, disabled }: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <form className="mt-3 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <input
        className="w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 font-mono text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
        aria-label={t("bot.workingFolder")}
        placeholder={t("bot.workingFolderPlaceholder")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="submit" disabled={disabled} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
        {t("bot.workingFolderSave")}
      </button>
    </form>
  );
}
