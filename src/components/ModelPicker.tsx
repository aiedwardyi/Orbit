import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Atom, BookOpen, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, Hexagon, Leaf, MoonStar, Mountain, Orbit, Sparkle, Sparkles, Sun, X } from "lucide-react";
import { useStore, type Bot, type ModelSelection } from "@/state/store";
import { filterCustomModels } from "@/lib/custom-models";
import { engineBadgeText, modelChipText, modelChipTitle } from "@/lib/model-chip";
import { movePicker, pickerColumn, pickerEfforts, pickerModels, pickerRows, selectPickerEffort, selectPickerModel } from "@/lib/cross-model-picker";
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
  const shortcutEnabled = !contained && state.selectedId === bot.id;
  const selection = bot.modelSelection;
  const active = state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState(selection);
  const [customOpen, setCustomOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const bindingsId = useId();
  const rows = pickerRows(state.instances, selection, draft);
  const row = rows.find((item) => item.instance.instanceId === draft.instanceId);
  const column = row ? pickerColumn(row, draft.model) : 0;
  const cell = row?.cells[column];
  const instance = row?.instance;
  const isCustom = instance?.models.options.some((option) => option.id === draft.model && option.custom);
  const blocked = Boolean(instance && (needsCli(instance) || (!isCustom && needsSignIn(instance))));
  const sameModelPin = draft.instanceId === selection.instanceId && draft.model === selection.model;
  const canSave = sameModelPin || Boolean(instance && !blocked && instance.models.options.some((option) => option.id === draft.model));
  const models = pickerModels(rows);
  const modelIndex = Math.max(0, models.findIndex((item) => item.instance === instance && item.cell === cell));
  const efforts = row && cell ? pickerEfforts(row, cell) : [];
  const effortIndex = efforts.findIndex((option) => option.model ? option.model === draft.model : option.effort === draft.effort);
  const split = Math.ceil(efforts.length / 2);
  const planeStyle: CSSProperties & { "--picker-columns": number } = { "--picker-columns": Math.max(split, efforts.length - split) * 2 + 1 };
  const effortPosition = (index: number) => index < split ? index - split : index - split + 1;
  const families = new Map([["codex", "gpt"], ["grokAgent", "grok"], ["antigravityAgent", "gemini"], ["geminiAgent", "gemini"], ["claudeAgent", "claude"], ["opencodeGo", "opencode"]]);
  const family = families.get(instance?.driverKind ?? "") ?? "grok";
  const shortcut = /Mac/i.test(globalThis.navigator?.platform ?? "") ? "Option" : "Alt";
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
      if (!shortcutEnabled || (!open && document.querySelector('[role="dialog"]'))) return;
      event.preventDefault();
      if (open) close();
      else show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, shortcutEnabled, selection]);

  useEffect(() => {
    if (!open) return;
    void refreshInstances();
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.current;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, [open, refreshInstances]);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={show}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-keyshortcuts={shortcutEnabled ? "Alt+P" : undefined}
      className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-control/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised-hover"
      title={modelChipTitle({ mode: selection.mode, instance: active, model: selection.model }, t) + (shortcutEnabled ? ` (${shortcut}+P)` : "")}
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
    <div className="model-cross-backdrop" data-picker-family={family} data-contained={contained || undefined} onMouseDown={(event) => {
      if (event.target === event.currentTarget || (event.target instanceof Element && event.target.matches(".model-cross-plane, .model-cross-stage"))) close();
    }}>
      <div
        ref={dialogRef}
        data-model-picker-content
        role="dialog"
        aria-modal="true"
        aria-label={t("model.choose")}
        aria-describedby={bindingsId}
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
          <h2 className="sr-only">{t("model.choose")}</h2>
          <button data-picker-action type="button" onClick={close} aria-label={t("createBot.cancel")}><X size={18} /></button>
        </header>
        <div className="model-cross-stage" aria-label={t("engines.models")}>
          <div className="model-cross-plane" style={planeStyle}>
            <div className="model-cross-column" style={{ transform: `translateY(calc(${modelIndex} * -1 * var(--picker-y-step)))` }}>
              {models.map((item) => {
                const selected = item.instance === instance && item.cell === cell;
                const option = item.cell;
                const id = selected ? draft.model : option.options[0]!.id;
                const gpt = id.match(/^(gpt-[\d.]+)-(astra|sol|terra|luna)$/i);
                const ModelIcon = /astra/i.test(id) ? Atom : /sol/i.test(id) ? Sun : /terra/i.test(id) ? Mountain
                  : /luna/i.test(id) ? MoonStar : /fable/i.test(id) ? BookOpen : /haiku/i.test(id) ? Leaf
                  : /opus/i.test(id) ? Sun : /sonnet/i.test(id) ? Sparkles : Orbit;
                return (
                  <button
                    key={`${item.instance.instanceId}:${option.options[0]!.id}`}
                    type="button"
                    data-model-row={item.instance.instanceId}
                    data-model-cell={option.options[0]!.id}
                    aria-pressed={selected}
                    tabIndex={selected ? 0 : -1}
                    className="model-cross-cell"
                    title={option.options.map((model) => model.id).join("\n")}
                    onClick={() => pick(selectPickerModel(item.instance, id, draft))}
                  >
                    <ModelIcon size={30} strokeWidth={1.1} aria-hidden />
                    <span className="model-cross-engine">{gpt ? gpt[1]!.replace("gpt-", "GPT ") : item.label}</span>
                    <span className="model-cross-name">{gpt ? gpt[2]![0]!.toUpperCase() + gpt[2]!.slice(1) : option.label}</span>
                    {option.offList && <span className="model-cross-note">{t("model.offList")}</span>}
                  </button>
                );
              })}
            </div>
            {cell && <div data-model-chrome className="model-cross-chrome model-cross-model-chrome" aria-hidden />}
            {efforts.length > 0 && <div data-effort-axis className="model-cross-efforts" aria-label={t("model.effort")}>
              {efforts.map((option, index) => {
                const EffortIcon = option.id === "default" ? Circle : option.label === "low" ? Sparkle
                  : option.label === "medium" ? Orbit : option.label === "high" ? Sparkles : option.label === "xhigh" ? Sun : Hexagon;
                return <button
                  key={option.id}
                  type="button"
                  className="model-cross-cell model-cross-effort"
                  data-model-tier={option.model}
                  data-picker-effort={option.id}
                  aria-pressed={index === effortIndex}
                  style={{ transform: `translateX(calc(${effortPosition(index)} * var(--picker-x-step)))` }}
                  onClick={() => pick(selectPickerEffort(draft, option))}
                >
                  <EffortIcon size={26} strokeWidth={1.1} aria-hidden />
                  <span className="model-cross-name">{option.id === "default" ? t("model.default") : option.label === "xhigh" ? t("model.extraHigh") : option.label}</span>
                </button>;
              })}
              {effortIndex >= 0 && <div data-effort-chrome className="model-cross-chrome model-cross-effort-chrome" aria-hidden style={{ transform: `translateX(calc(${effortPosition(effortIndex)} * var(--picker-x-step)))` }} />}
              <button data-picker-action type="button" className="model-cross-chevron model-cross-left" aria-label={t("model.previousEffort")} style={{ left: `calc(50% - ${split + 0.65} * var(--picker-x-step))` }} onClick={() => pick(movePicker(rows, draft, "ArrowLeft"))}><ChevronLeft size={14} /></button>
              <button data-picker-action type="button" className="model-cross-chevron model-cross-right" aria-label={t("model.nextEffort")} style={{ left: `calc(50% + ${efforts.length - split + 0.65} * var(--picker-x-step))` }} onClick={() => pick(movePicker(rows, draft, "ArrowRight"))}><ChevronRight size={14} /></button>
            </div>}
            <button data-picker-action type="button" className="model-cross-chevron model-cross-up" aria-label={t("model.previousModel")} onClick={() => pick(movePicker(rows, draft, "ArrowUp"))}><ChevronUp size={14} /></button>
            <button data-picker-action type="button" className="model-cross-chevron model-cross-down" aria-label={t("model.nextModel")} onClick={() => pick(movePicker(rows, draft, "ArrowDown"))}><ChevronDown size={14} /></button>
          </div>
          <button data-picker-action type="button" className="model-cross-edge model-cross-top" aria-label={t("model.previousModel")} onClick={() => pick(movePicker(rows, draft, "ArrowUp"))}><ChevronUp size={12} /></button>
          <button data-picker-action type="button" className="model-cross-edge model-cross-bottom" aria-label={t("model.nextModel")} onClick={() => pick(movePicker(rows, draft, "ArrowDown"))}><ChevronDown size={12} /></button>
        </div>
        <div className="model-cross-options">
          <div aria-live="polite" className="flex min-w-0 flex-wrap items-center justify-center gap-2 text-xs text-ink-secondary">
            <span>{t("model.automatic")}</span>
            <span className="break-all text-ink">{t("model.automaticHelp", { name: draft.model || t("model.unresolved") })}</span>
            {effortIndex >= 0 && <span>{t("model.effort")}: {efforts[effortIndex]!.id === "default" ? t("model.default") : efforts[effortIndex]!.label === "xhigh" ? t("model.extraHigh") : efforts[effortIndex]!.label}</span>}
            {!instance && <span>{t("model.offList")}</span>}
            {instance && <span className={cn("rounded-full px-2 py-0.5", blocked ? "bg-warning/10 text-warning" : "bg-success/10 text-success")}>
              {engineBadgeText(instance.snapshot, needsCli(instance) ? "not-installed" : needsSignIn(instance) ? "sign-in" : "ready", t)}
            </span>}
          </div>
          {blocked && instance && <EngineSetup instance={instance} intent={isCustom ? "inject" : "cloud"} />}
          {custom.length > 0 && <button type="button" className="text-xs text-ink-secondary hover:text-ink" aria-expanded={customOpen} onClick={() => setCustomOpen(!customOpen)}>{t("model.useLocalCount", { count: custom.length })}</button>}
          {customOpen && instance && <div className="model-cross-custom">
            <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("model.searchLocal")} placeholder={t("model.searchLocal")} className="w-full rounded-lg bg-inset px-3 py-2 text-base sm:text-sm text-ink" />
            {filteredCustom.map((option) => <button key={option.id} type="button" className="block w-full rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-control" onClick={() => pick(selectPickerModel(instance, option.id, draft))}>{option.label}</button>)}
            {filteredCustom.length === 0 && <p className="text-xs text-ink-secondary">{t("palette.noMatch", { query })}</p>}
          </div>}
        </div>
        <footer className="model-cross-footer" id={bindingsId}>
          <span className="model-cross-binding"><kbd>{shortcut}</kbd><kbd>P</kbd></span>
          <span className="model-cross-binding"><kbd>↑</kbd><kbd>↓</kbd>{t("model.engineAxis")}</span>
          <span className="model-cross-binding"><kbd>←</kbd><kbd>→</kbd>{t("model.modelAxis")}</span>
          <button type="button" disabled={!canSave} className="model-cross-binding" onClick={save}><kbd>Enter</kbd>{t("settings.profile.save")}</button>
          <button data-picker-action type="button" className="model-cross-binding" onClick={close}><kbd>Esc</kbd>{t("createBot.cancel")}</button>
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
