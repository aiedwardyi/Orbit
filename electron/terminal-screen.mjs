const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_ROWS = 300;
const MAX_COLS = 500;
const MAX_CELL_TEXT = 256;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function blankRow(cols) {
  return { chars: Array.from({ length: cols }, () => " "), styles: Array(cols).fill(null) };
}

function spliceBlank(line, start, deleteCount, insertCount) {
  line.chars.splice(start, deleteCount, ...Array(insertCount).fill(" "));
  line.styles.splice(start, deleteCount, ...Array(insertCount).fill(null));
}

function truncateRow(line, cols) {
  line.chars.length = cols;
  line.styles.length = cols;
}

function hexColor(r, g, b) {
  return `#${[r, g, b].map((value) => clamp(value ?? 0, 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

// Pens are replaced, never mutated, so cells share them by reference.
function applySgr(pen, values) {
  const params = values.length ? values : [0];
  const next = { ...pen };
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i];
    if (p === 0) for (const key of Object.keys(next)) delete next[key];
    else if (p === 1) next.b = 1;
    else if (p === 2) next.d = 1;
    else if (p === 3) next.i = 1;
    else if (p === 4) next.u = 1;
    else if (p === 7) next.inv = 1;
    else if (p === 9) next.s = 1;
    else if (p === 22) { delete next.b; delete next.d; }
    else if (p === 23) delete next.i;
    else if (p === 24) delete next.u;
    else if (p === 27) delete next.inv;
    else if (p === 29) delete next.s;
    else if (p >= 30 && p <= 37) next.fg = p - 30;
    else if (p === 39) delete next.fg;
    else if (p >= 40 && p <= 47) next.bg = p - 40;
    else if (p === 49) delete next.bg;
    else if (p >= 90 && p <= 97) next.fg = p - 82;
    else if (p >= 100 && p <= 107) next.bg = p - 92;
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      if (params[i + 1] === 5 && i + 2 < params.length) {
        next[key] = clamp(params[i + 2], 0, 255);
        i += 2;
      } else if (params[i + 1] === 2 && i + 4 < params.length) {
        next[key] = hexColor(params[i + 2], params[i + 3], params[i + 4]);
        i += 4;
      } else break;
    }
  }
  return Object.keys(next).length ? next : null;
}

function runStyle(pen) {
  if (!pen) return { key: "", attrs: {} };
  const fg = pen.inv ? pen.bg ?? 0 : pen.fg;
  const bg = pen.inv ? pen.fg ?? 7 : pen.bg;
  const attrs = {};
  if (fg !== undefined) attrs.fg = fg;
  if (bg !== undefined) attrs.bg = bg;
  for (const flag of ["b", "d", "i", "u", "s"]) if (pen[flag]) attrs[flag] = 1;
  return { key: JSON.stringify(attrs), attrs };
}

function rowRuns(line, styleOf) {
  let end = line.chars.length;
  while (end > 0 && !line.styles[end - 1] && line.chars[end - 1].trim() === "") end -= 1;
  const runs = [];
  let last = null;
  let lastKey = null;
  for (let x = 0; x < end; x += 1) {
    const { key, attrs } = styleOf(line.styles[x]);
    if (last && key === lastKey) last.t += line.chars[x];
    else {
      last = { t: line.chars[x], ...attrs };
      lastKey = key;
      runs.push(last);
    }
  }
  return runs;
}

function dropLeading(runs, count) {
  let remaining = count;
  while (remaining > 0 && runs.length) {
    if (runs[0].t.length <= remaining) remaining -= runs.shift().t.length;
    else {
      runs[0].t = runs[0].t.slice(remaining);
      remaining = 0;
    }
  }
  return runs;
}

function blankBuffer(cols, rows) {
  return Array.from({ length: rows }, () => blankRow(cols));
}

function isCombining(codePoint) {
  return (
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function charWidth(char) {
  const codePoint = char.codePointAt(0) ?? 0;
  if (isCombining(codePoint) || codePoint === 0) return 0;
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff))
  ) return 2;
  return 1;
}

function parseParams(raw) {
  const privateMode = raw.startsWith("?");
  const normalized = raw.replace(/^[?>!]/, "");
  const values = normalized === "" ? [] : normalized.split(/[;:]/).map((value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return { privateMode, values };
}

function positive(value, maximum, fallback = 1) {
  return clamp(value > 0 ? value : fallback, 1, maximum);
}

function limitText(text, max) {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(-max), truncated: true };
}

/** A bounded terminal screen model for hidden/unmounted terminal reads. */
export function createTerminalScreen({ cols = DEFAULT_COLS, rows = DEFAULT_ROWS, scrollback = 200 } = {}) {
  let width = clamp(Number.isInteger(cols) ? cols : DEFAULT_COLS, 2, MAX_COLS);
  let height = clamp(Number.isInteger(rows) ? rows : DEFAULT_ROWS, 1, MAX_ROWS);
  const scrollbackLimit = clamp(Number.isInteger(scrollback) ? scrollback : 200, 0, 2_000);
  let main = makeBuffer();
  let alternate = makeBuffer();
  let active = main;
  let alternateMode = false;
  let cursorX = 0;
  let cursorY = 0;
  let savedCursor = { x: 0, y: 0 };
  let alternateRestoreCursor = { x: 0, y: 0 };
  let scrollTop = 0;
  let scrollBottom = height - 1;
  let wrapPending = false;
  let insertMode = false;
  const privateModes = new Set();
  const resetPrivateModes = new Set();
  let parserState = "normal";
  let csi = "";
  let osc = "";
  let scrollbackLines = [];
  let pen = null;

  function makeBuffer() {
    return { rows: blankBuffer(width, height) };
  }

  function row(y) {
    return active.rows[clamp(y, 0, height - 1)];
  }

  function normalizeCursor() {
    cursorX = clamp(cursorX, 0, width - 1);
    cursorY = clamp(cursorY, 0, height - 1);
    wrapPending = false;
  }

  function addScrollback(line) {
    if (alternateMode || scrollbackLimit === 0) return;
    scrollbackLines.push(line.chars.join("").replace(/\s+$/u, ""));
    if (scrollbackLines.length > scrollbackLimit) scrollbackLines = scrollbackLines.slice(-scrollbackLimit);
  }

  function scrollUp(count = 1) {
    const amount = Math.max(1, count);
    for (let i = 0; i < amount; i += 1) {
      addScrollback(active.rows[scrollTop]);
      active.rows.splice(scrollTop, 1);
      active.rows.splice(scrollBottom, 0, blankRow(width));
    }
  }

  function scrollDown(count = 1) {
    const amount = Math.max(1, count);
    for (let i = 0; i < amount; i += 1) {
      active.rows.splice(scrollBottom, 1);
      active.rows.splice(scrollTop, 0, blankRow(width));
    }
  }

  function lineFeed() {
    wrapPending = false;
    if (cursorY === scrollBottom) scrollUp();
    else cursorY = Math.min(height - 1, cursorY + 1);
  }

  function carriageReturn() {
    cursorX = 0;
    wrapPending = false;
  }

  function eraseLine(start, end) {
    const current = row(cursorY);
    for (let x = clamp(start, 0, width); x < clamp(end, 0, width); x += 1) {
      current.chars[x] = " ";
      current.styles[x] = null;
    }
  }

  function eraseDisplay(mode) {
    if (mode === 3) {
      scrollbackLines = [];
      mode = 2;
    }
    if (mode === 0) {
      eraseLine(cursorX, width);
      for (let y = cursorY + 1; y < height; y += 1) active.rows[y] = blankRow(width);
    } else if (mode === 1) {
      for (let y = 0; y < cursorY; y += 1) active.rows[y] = blankRow(width);
      eraseLine(0, cursorX + 1);
    } else if (mode === 2) {
      active.rows = blankBuffer(width, height);
    }
    wrapPending = false;
  }

  function switchAlternate(enabled, clear = true) {
    if (enabled === alternateMode) return;
    if (enabled) {
      alternateRestoreCursor = { x: cursorX, y: cursorY };
      alternateMode = true;
      active = alternate;
      if (clear) alternate = makeBuffer();
      active = alternate;
      cursorX = 0;
      cursorY = 0;
      scrollTop = 0;
      scrollBottom = height - 1;
    } else {
      alternateMode = false;
      active = main;
      cursorX = clamp(alternateRestoreCursor.x, 0, width - 1);
      cursorY = clamp(alternateRestoreCursor.y, 0, height - 1);
      scrollTop = 0;
      scrollBottom = height - 1;
    }
    wrapPending = false;
  }

  function moveCursor(dx, dy) {
    cursorX += dx;
    cursorY += dy;
    normalizeCursor();
  }

  function writeChar(char) {
    const widthOfChar = charWidth(char);
    if (widthOfChar === 0) {
      const { chars } = active.rows[cursorY];
      if (cursorX > 0 && chars[cursorX - 1].length < MAX_CELL_TEXT) chars[cursorX - 1] += char;
      return;
    }
    if (wrapPending) {
      carriageReturn();
      lineFeed();
    }
    if (widthOfChar === 2 && cursorX === width - 1) {
      wrapPending = true;
      carriageReturn();
      lineFeed();
    }
    const line = active.rows[cursorY];
    if (insertMode) spliceBlank(line, cursorX, 0, widthOfChar);
    line.chars[cursorX] = char;
    line.styles[cursorX] = pen;
    if (widthOfChar === 2 && cursorX + 1 < width) {
      line.chars[cursorX + 1] = " ";
      line.styles[cursorX + 1] = pen;
    }
    if (insertMode) truncateRow(line, width);
    cursorX += widthOfChar;
    if (cursorX >= width) {
      cursorX = width - 1;
      wrapPending = true;
    }
  }

  function csiAction(raw, final) {
    const parsed = parseParams(raw);
    const rowCount = Math.max(1, scrollBottom - cursorY + 1);
    const first = (maximum, fallback = 1) => positive(parsed.values[0] ?? 0, maximum, fallback);
    const [a = 0, b = 0] = parsed.values;
    if (parsed.privateMode && (final === "h" || final === "l")) {
      const enabled = final === "h";
      for (const mode of parsed.values) {
        if (enabled) {
          privateModes.add(mode);
          resetPrivateModes.delete(mode);
        } else {
          privateModes.delete(mode);
          resetPrivateModes.add(mode);
        }
        if (mode === 47 || mode === 1047) switchAlternate(enabled, mode === 1047);
        if (mode === 1049) switchAlternate(enabled, true);
      }
      return;
    }
    switch (final) {
      case "A": moveCursor(0, -first(height)); break;
      case "B":
      case "e": moveCursor(0, first(height)); break;
      case "C":
      case "a": moveCursor(first(width), 0); break;
      case "D": moveCursor(-first(width), 0); break;
      case "E": cursorX = 0; moveCursor(0, first(height)); break;
      case "F": cursorX = 0; moveCursor(0, -first(height)); break;
      case "G":
      case "`": cursorX = clamp((a || 1) - 1, 0, width - 1); wrapPending = false; break;
      case "d": cursorY = clamp((a || 1) - 1, 0, height - 1); wrapPending = false; break;
      case "H":
      case "f":
        cursorY = clamp((a || 1) - 1, 0, height - 1);
        cursorX = clamp((b || 1) - 1, 0, width - 1);
        wrapPending = false;
        break;
      case "J": eraseDisplay(a); break;
      case "K": eraseLine(a === 1 ? 0 : a === 2 ? 0 : cursorX, a === 2 ? width : a === 0 ? width : cursorX + 1); break;
      case "L": {
        const amount = first(rowCount);
        for (let i = 0; i < amount; i += 1) {
          active.rows.splice(cursorY, 0, blankRow(width));
          active.rows.splice(scrollBottom + 1, 1);
        }
        break;
      }
      case "M": {
        const amount = first(rowCount);
        for (let i = 0; i < amount; i += 1) {
          active.rows.splice(cursorY, 1);
          active.rows.splice(scrollBottom, 0, blankRow(width));
        }
        break;
      }
      case "P": {
        const amount = first(width - cursorX);
        const current = active.rows[cursorY];
        spliceBlank(current, cursorX, amount, 0);
        spliceBlank(current, current.chars.length, 0, amount);
        truncateRow(current, width);
        break;
      }
      case "@": {
        const amount = first(width - cursorX);
        spliceBlank(active.rows[cursorY], cursorX, 0, amount);
        truncateRow(active.rows[cursorY], width);
        break;
      }
      case "X": eraseLine(cursorX, cursorX + first(width - cursorX)); break;
      case "S": scrollUp(first(height)); break;
      case "T": scrollDown(first(height)); break;
      case "r":
        scrollTop = clamp((a || 1) - 1, 0, height - 1);
        scrollBottom = clamp((b || height) - 1, scrollTop, height - 1);
        cursorX = 0;
        cursorY = scrollTop;
        wrapPending = false;
        break;
      case "s": savedCursor = { x: cursorX, y: cursorY }; break;
      case "u": cursorX = savedCursor.x; cursorY = savedCursor.y; wrapPending = false; break;
      case "h": if (a === 4) insertMode = true; break;
      case "l": if (a === 4) insertMode = false; break;
      case "m": if (!/^[?>!=<]/.test(raw)) pen = applySgr(pen, parsed.values); break;
      default: break;
    }
  }

  function consume(data) {
    for (const char of String(data)) {
      if (parserState === "normal") {
        if (char === "\x1b") parserState = "escape";
        else if (char === "\x9b") { parserState = "csi"; csi = ""; }
        else if (char === "\x9d") { parserState = "osc"; osc = ""; }
        else if (char === "\x90" || char === "\x98" || char === "\x9e" || char === "\x9f") parserState = "string";
        else if (char === "\r") carriageReturn();
        else if (char === "\n" || char === "\v" || char === "\f") lineFeed();
        else if (char === "\b") cursorX = Math.max(0, cursorX - 1);
        else if (char === "\t") cursorX = Math.min(width - 1, cursorX + (8 - (cursorX % 8)));
        else if (char === "\x07") continue;
        else if (char >= " " && char !== "\x7f") writeChar(char);
        continue;
      }
      if (parserState === "escape") {
        if (char === "[") { parserState = "csi"; csi = ""; }
        else if (char === "]") { parserState = "osc"; osc = ""; }
        else if (char === "P" || char === "^" || char === "_") parserState = "string";
        else if (char === "7") { savedCursor = { x: cursorX, y: cursorY }; parserState = "normal"; }
        else if (char === "8") { cursorX = savedCursor.x; cursorY = savedCursor.y; wrapPending = false; parserState = "normal"; }
        else if (char === "D") { lineFeed(); parserState = "normal"; }
        else if (char === "E") { carriageReturn(); lineFeed(); parserState = "normal"; }
        else if (char === "M") { if (cursorY === scrollTop) scrollDown(); else cursorY -= 1; parserState = "normal"; }
        else if (char === "c") { main = makeBuffer(); alternate = makeBuffer(); active = alternateMode ? alternate : main; cursorX = 0; cursorY = 0; savedCursor = { x: 0, y: 0 }; alternateRestoreCursor = { x: 0, y: 0 }; scrollTop = 0; scrollBottom = height - 1; scrollbackLines = []; pen = null; privateModes.clear(); resetPrivateModes.clear(); parserState = "normal"; }
        else { parserState = "normal"; }
        continue;
      }
      if (parserState === "csi") {
        if (char >= "@" && char <= "~") { csiAction(csi, char); parserState = "normal"; csi = ""; }
        else if (csi.length < 64) csi += char;
        continue;
      }
      if (parserState === "osc") {
        if (char === "\x07") parserState = "normal";
        else if (char === "\x1b") parserState = "oscEscape";
        else if (osc.length < 2048) osc += char;
        continue;
      }
      if (parserState === "oscEscape") {
        parserState = char === "\\" || char === "\x07" ? "normal" : "osc";
        continue;
      }
      if (parserState === "string") {
        if (char === "\x1b") parserState = "stringEscape";
        continue;
      }
      if (parserState === "stringEscape") {
        parserState = char === "\\" ? "normal" : "string";
      }
    }
  }

  function resize(nextCols, nextRows) {
    const newWidth = clamp(Number.isInteger(nextCols) ? nextCols : width, 2, MAX_COLS);
    const newHeight = clamp(Number.isInteger(nextRows) ? nextRows : height, 1, MAX_ROWS);
    if (newWidth === width && newHeight === height) return;
    const resizeBuffer = (buffer) => {
      const rows = buffer.rows.slice(0, newHeight).map((line) => {
        const pad = Math.max(0, newWidth - line.chars.length);
        return { chars: [...line.chars.slice(0, newWidth), ...Array(pad).fill(" ")], styles: [...line.styles.slice(0, newWidth), ...Array(pad).fill(null)] };
      });
      while (rows.length < newHeight) rows.push(blankRow(newWidth));
      return { rows };
    };
    width = newWidth;
    height = newHeight;
    main = resizeBuffer(main);
    alternate = resizeBuffer(alternate);
    active = alternateMode ? alternate : main;
    scrollTop = 0;
    scrollBottom = height - 1;
    normalizeCursor();
  }

  function snapshot({ maxScreenChars = 64 * 1024, maxScrollbackChars = 16 * 1024 } = {}) {
    const lines = active.rows.map((line) => line.chars.join("").replace(/\s+$/u, ""));
    const screen = lines.join("\n");
    const recent = scrollbackLines.join("\n");
    const limitedScreen = limitText(screen, maxScreenChars);
    const limitedRecent = limitText(recent, maxScrollbackChars);
    const keptLines = limitedScreen.text.split("\n");
    const firstKept = lines.length - keptLines.length;
    const styles = new Map();
    const styleOf = (style) => {
      if (!styles.has(style)) styles.set(style, runStyle(style));
      return styles.get(style);
    };
    const screenRuns = active.rows.slice(firstKept).map((line) => rowRuns(line, styleOf));
    if (limitedScreen.truncated) dropLeading(screenRuns[0], lines[firstKept].length - keptLines[0].length);
    return {
      cols: width,
      rows: height,
      screenText: limitedScreen.text,
      screenRuns,
      recentText: limitedRecent.text,
      alternate: alternateMode,
      modes: [...privateModes].sort((a, b) => a - b),
      resetModes: [...resetPrivateModes].sort((a, b) => a - b),
      cursor: { col: cursorX, row: cursorY },
      truncated: limitedScreen.truncated || limitedRecent.truncated,
    };
  }

  return { consume, resize, snapshot };
}
