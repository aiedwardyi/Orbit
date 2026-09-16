import { useState } from "react";
import { applyGeometry, readGeometry, type Geometry } from "@/lib/geometry";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export function GeometryPicker() {
  const { t } = useI18n();
  const [geometry, setGeometry] = useState(readGeometry);
  return (
    <div className="flex shrink-0 gap-0.5 rounded-lg border border-hairline/50 bg-inset p-0.5" role="group" aria-label={t("settings.shape.title")}>
      {(["soft", "boxy"] as const).map((value: Geometry) => (
        <button
          key={value}
          type="button"
          aria-pressed={geometry === value}
          onClick={() => { applyGeometry(value); setGeometry(value); }}
          className={cn(
            "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            geometry === value ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
          )}
        >
          {t(`settings.shape.${value}`)}
        </button>
      ))}
    </div>
  );
}
