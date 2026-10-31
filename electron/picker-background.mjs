const backgrounds = new WeakMap();

function pickerColor(view, theme) {
  if (view === "dial") return "#050608";
  const base = theme.slice(-6).match(/../g).map((value) => parseInt(value, 16));
  const color = [3, 4, 7].map((value, index) => Math.round((value * 245 + base[index] * 10) / 255));
  return `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function setModelPickerBackground(win, view) {
  if (!win || win.isDestroyed() || (view !== null && view !== "dial" && view !== "list")) return false;
  const previous = backgrounds.get(win);
  const current = win.getBackgroundColor();
  if (view === null) {
    if (previous && current === previous.painted) win.setBackgroundColor(previous.theme);
    backgrounds.delete(win);
    return true;
  }
  const theme = previous && current === previous.painted ? previous.theme : current;
  win.setBackgroundColor(pickerColor(view, theme));
  backgrounds.set(win, { theme, painted: win.getBackgroundColor() });
  return true;
}
