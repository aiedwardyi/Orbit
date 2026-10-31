export type ModelPickerView = "dial" | "list";

const KEY = "omb-model-picker-view";

export function loadModelPickerView(): ModelPickerView {
  try {
    return localStorage.getItem(KEY) === "list" ? "list" : "dial";
  } catch {
    return "dial";
  }
}

export function saveModelPickerView(view: ModelPickerView): void {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    /* The choice still applies for this session. */
  }
}
