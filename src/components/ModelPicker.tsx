import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Sparkles, X } from "lucide-react";
import { useStore, type Bot, type ModelSelection } from "@/state/store";
import { filterCustomModels } from "@/lib/custom-models";
import { engineBadgeText, modelChipText, modelChipTitle } from "@/lib/model-chip";
import { centeredItems, movePicker, pickerColumn, pickerRows, selectPickerModel } from "@/lib/cross-model-picker";
import { ProviderMark } from "./ProviderIcons";
import { EngineSetup, needsCli, needsSignIn } from "./EngineSetup";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import "./ModelPicker.css";

type ModelPickerProps = {
  bot: Bot;
  className?: string;
  contained?: boolean;
  label?: ReactNode;
  defaultOpen?: boolean;
};

type PickerStore = {
  state: Pick<ReturnType<typeof useStore>["state"], "instances" | "selectedId">;
  dispatch: ReturnType<typeof useStore>["dispatch"];
  refreshInstances: () => Promise<void>;
};

export function ModelPicker(props: ModelPickerProps) {
  const store = useStore();
  return <ModelPickerControl {...props} store={store} />;
}

export function ModelPickerControl({
  bot, className, contained = false, label, defaultOpen = false, store,
}: ModelPickerProps & { store: PickerStore }) {
  const { t } = useI18n();
  const { state, dispatch, refreshInstances } = store;
  const selection = bot.modelSelection;
  const active = state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState(selection);
  const [customOpen, setCustomOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cellRef = useRef<HTMLButtonElement>(null);
  const rows = pickerRows(state.instances, selection, draft);
  const row = rows.find((item) => item.instance.instanceId === draft.instanceId);
  const column = row ? pickerColumn(row, draft.model) : 0;
  const cell = row?.cells[column];
  const instance = row?.instance;
  const isCustom = instance?.models.options.some((option) => option.id === draft.model && option.custom);
  const blocked = Boolean(instance && (needsCli(instance) || (!isCustom && needsSignIn(instance))));
  const unchanged = draft.instanceId === selection.instanceId && draft.model === selection.model;
  const canSave = unchanged || Boolean(instance && !blocked && instance.models.options.some((option) => option.id === draft.model));
  const efforts = instance?.capabilities?.effortLevels ?? [];
  const custom = instance?.models.options.filter((option) => option.custom) ?? [];
  const filteredCustom = filterCustomModels(custom, query);

  const show = () => {
    setDraft(selection);
    setCustomOpen(false);
    setQuery("");
    setOpen(true);
  };
  const close = () => setOpen(false);
  const save = () => {
    if (!canSave) return;
    dispatch({ type: "setModel", botId: bot.id, selection: draft });
    close();
  };
  const pick = (next: ModelSelection) => {
    setDraft(next);
    setCustomOpen(false);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== "KeyP") return;
      if (state.selectedId !== bot.id || contained || (!open && document.querySelector('[role="dialog"]'))) return;
      event.preventDefault();
      if (open) close();
      else show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, state.selectedId, bot.id, contained, selection]);

  useEffect(() => {
    if (!open) return;
    void refreshInstances();
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.current;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, [open, refreshInstances]);

  useEffect(() => {
    const stage = stageRef.current;
    const selected = cellRef.current;
    if (!stage || !selected) return;
    const center = () => {
      stage.scrollLeft = selected.offsetLeft + selected.offsetWidth / 2 - stage.clientWidth / 2;
      stage.scrollTop = selected.offsetTop + selected.offsetHeight / 2 - stage.clientHeight / 2;
    };
    center();
    const observer = new window.ResizeObserver(center);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [open, draft.instanceId, draft.model, state.instances]);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={show}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-keyshortcuts="Alt+P"
      className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-control/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised-hover"
      title={modelChipTitle({ mode: selection.mode, instance: active, model: selection.model }, t) + " (Alt+P)"}
    >
      {active ? <ProviderMark driverKind={active.driverKind} size={14} /> : <Sparkles size={14} className="text-accent" />}
      <span className={cn("max-w-[160px] truncate", !contained && active && "@max-4xl/chathead:hidden")}>
        {modelChipText({ instance: active, model: selection.model }, t)}
      </span>
      {!contained && active && <span className="hidden max-w-[96px] truncate @max-4xl/chathead:inline">{active.displayName}</span>}
      <ChevronDown size={14} className={cn("text-ink-secondary", !contained && active && "@max-4xl/chathead:hidden")} />
    </button>
  );

  const dialog = (
    <div className="model-cross-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div
        ref={dialogRef}
        data-model-picker-content
        role="dialog"
        aria-modal="true"
        aria-label={t("model.choose")}
        aria-describedby="model-cross-bindings"
        tabIndex={-1}
        className="model-cross-dialog"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" || (event.altKey && !event.ctrlKey && !event.shiftKey && event.code === "KeyP")) {
            event.preventDefault();
            close();
          } else if (event.key === "Enter") {
            if (event.target !== event.currentTarget && !(event.target instanceof HTMLElement && event.target.closest("[data-model-cell]"))) return;
            event.preventDefault();
            save();
          } else if (event.key === "Tab") {
            const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]') ?? []);
            const first = buttons[0];
            const last = buttons[buttons.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && !(event.target instanceof HTMLInputElement)) {
            event.preventDefault();
            pick(movePicker(rows, draft, event.key));
          }
        }}
      >
        <header className="model-cross-header">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">{t("model.choose")}</h2>
            <p className="mt-1 text-xs text-ink-secondary">{t("model.crossHelp")}</p>
          </div>
          <button data-picker-action type="button" onClick={close} aria-label={t("createBot.cancel")} className="rounded-lg p-2 text-ink-secondary hover:bg-control"><X size={18} /></button>
        </header>
        <div className="model-cross-legend">
          <span className="model-cross-engine-label"><button data-picker-action type="button" aria-label={t("model.previousEngine")} onClick={() => pick(movePicker(rows, draft, "ArrowUp"))}>↑</button> {t("model.engineAxis")} <button data-picker-action type="button" aria-label={t("model.nextEngine")} onClick={() => pick(movePicker(rows, draft, "ArrowDown"))}>↓</button></span>
          <span className="text-accent-text"><button data-picker-action type="button" aria-label={t("model.previousModel")} onClick={() => pick(movePicker(rows, draft, "ArrowLeft"))}>←</button> {t("model.modelAxis")} <button data-picker-action type="button" aria-label={t("model.nextModel")} onClick={() => pick(movePicker(rows, draft, "ArrowRight"))}>→</button></span>
        </div>
        <div ref={stageRef} className="model-cross-stage" aria-label={t("model.switchEngine")}>
          <div className="model-cross-grid" aria-label={t("engines.models")}>
            {centeredItems(rows, Math.max(0, rows.findIndex((item) => item === row))).map((item) => {
              const selectedRow = item === row;
              const projectedColumn = Math.min(column, item.cells.length - 1);
              const shown = selectedRow ? centeredItems(item.cells, column) : item.cells.slice(projectedColumn, projectedColumn + 1);
              return (
                <div key={item.instance.instanceId} className="model-cross-row" data-model-row={item.instance.instanceId} data-active={selectedRow || undefined} style={{ paddingLeft: selectedRow ? 0 : `calc(${Math.floor((row?.cells.length ?? 1) / 2)} * var(--model-cross-step))` }}>
                  {item.cells.length === 0 && <div className="model-cross-empty">{item.label}<br />{t("model.noPickerModels")}</div>}
                  {shown.map((option) => {
                    const selected = selectedRow && option.options.some((model) => model.id === draft.model);
                    return (
                      <button
                        key={option.options[0]!.id}
                        ref={selected ? cellRef : undefined}
                        type="button"
                        data-model-cell={option.options[0]!.id}
                        data-engine-axis={!selectedRow || selected || undefined}
                        aria-pressed={selected}
                        className="model-cross-cell"
                        title={option.options.map((model) => model.id).join("\n")}
                        onClick={() => pick(selectPickerModel(item.instance, selected ? draft.model : option.options[0]!.id, draft))}
                      >
                        <span className="model-cross-engine"><ProviderMark driverKind={item.instance.driverKind} size={15} />{item.label}</span>
                        <span className="model-cross-name">{option.label}</span>
                        {!selectedRow && <span className="model-cross-note">{t("model.modelCount", { count: item.cells.length })}</span>}
                        {selectedRow && option.offList && <span className="model-cross-note">{t("model.offList")}</span>}
                        {selectedRow && option.options.length > 1 && <span className="model-cross-note">{selected ? draft.model.split("-").at(-1) : t("model.tiers", { count: option.options.length })}</span>}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        <div className="model-cross-options">
          <div aria-live="polite" className="flex min-w-0 flex-wrap items-center justify-center gap-2 text-xs text-ink-secondary">
            <span>{t("model.automatic")}</span>
            <span className="break-all text-ink">{t("model.automaticHelp", { name: draft.model || t("model.unresolved") })}</span>
            {!instance && <span>{t("model.offList")}</span>}
            {instance && <span className={cn("rounded-full px-2 py-0.5", blocked ? "bg-warning/10 text-warning" : "bg-success/10 text-success")}>
              {engineBadgeText(instance.snapshot, needsCli(instance) ? "not-installed" : needsSignIn(instance) ? "sign-in" : "ready", t)}
            </span>}
          </div>
          {instance?.driverKind === "antigravityAgent" && cell && cell.options.length > 1 && (
            <div className="model-cross-strip" aria-label={t("model.tier")}>
              <span>{t("model.tier")}</span>
              {cell.options.map((option) => <button key={option.id} type="button" data-model-tier={option.id} aria-pressed={draft.model === option.id} onClick={() => pick(selectPickerModel(instance, option.id, draft))}>{option.id.split("-").at(-1)}</button>)}
            </div>
          )}
          {efforts.length > 0 && (
            <div data-effort-strip className="model-cross-strip" aria-label={t("model.effort")}>
              <span>{t("model.effort")}</span>
              <button type="button" aria-pressed={!draft.effort} onClick={() => { const { effort: _, ...next } = draft; setDraft(next); }}>{t("model.default")}</button>
              {efforts.map((effort) => <button key={effort} type="button" aria-pressed={draft.effort === effort} onClick={() => setDraft({ ...draft, effort })}>{effort}</button>)}
            </div>
          )}
          {blocked && instance && <EngineSetup instance={instance} intent={isCustom ? "inject" : "cloud"} />}
          {custom.length > 0 && <button type="button" className="text-xs text-ink-secondary hover:text-ink" aria-expanded={customOpen} onClick={() => setCustomOpen(!customOpen)}>{t("model.useLocalCount", { count: custom.length })}</button>}
          {customOpen && instance && <div className="model-cross-custom">
            <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("model.searchLocal")} placeholder={t("model.searchLocal")} className="w-full rounded-lg bg-inset px-3 py-2 text-base sm:text-sm text-ink" />
            {filteredCustom.map((option) => <button key={option.id} type="button" className="block w-full rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-control" onClick={() => pick(selectPickerModel(instance, option.id, draft))}>{option.label}</button>)}
            {filteredCustom.length === 0 && <p className="text-xs text-ink-secondary">{t("palette.noMatch", { query })}</p>}
          </div>}
        </div>
        <footer className="model-cross-footer">
          <span id="model-cross-bindings">{t("model.bindings")}</span>
          <div className="flex gap-2">
            <button data-picker-action type="button" className="rounded-lg px-3 py-1.5 text-xs text-ink hover:bg-control" onClick={close}>{t("createBot.cancel")}</button>
            <button type="button" disabled={!canSave} className="rounded-lg bg-accent px-4 py-1.5 text-xs disabled:opacity-40" onClick={save}>{t("settings.profile.save")}</button>
          </div>
        </footer>
      </div>
    </div>
  );

  return (
    <div className={cn(contained ? "w-full" : "relative", className)}>
      {contained ? <div className="flex items-center justify-between gap-4">{label}{trigger}</div> : trigger}
      {open && (globalThis.document ? createPortal(dialog, document.body) : dialog)}
    </div>
  );
}
