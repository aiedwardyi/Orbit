// Owner-only team usage. The relay answers only its configured owner's Google account.
(() => {
  const LABEL_RE = /^[a-z2-7]{16}$/;
  const CLIENT_RE = /^[0-9A-Za-z_-]+(?:\.[0-9A-Za-z_-]+)*\.apps\.googleusercontent\.com$/;
  const BASE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  const DAYS = 14;
  const UNCONFIGURED = "Sign-in is not configured.";
  const GOOGLE_DOWN = "Could not load Google sign-in. Check your connection and try again.";
  const OFFLINE = "Could not reach the relay. Try again.";
  const NOT_OWNER = "This page is only for the relay's owner.";
  const EMPTY = "No PCs yet.";

  let gis = null;
  let config = null;

  const $ = (id) => document.getElementById(id);
  const say = (text, tone) => {
    const status = $("status");
    status.textContent = text;
    status.className = tone ? `status ${tone}` : "status";
  };
  const isObject = (value) => Object.prototype.toString.call(value) === "[object Object]";
  const text = (value) => (Object.prototype.toString.call(value) === "[object String]" ? value : "");
  const num = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);

  function readConfig() {
    const raw = globalThis.WINK_SIGNIN;
    if (!isObject(raw)) return null;
    const clientId = text(raw.clientId);
    const base = text(raw.base);
    if (!CLIENT_RE.test(clientId) || !BASE_RE.test(base)) return null;
    return { clientId, base };
  }

  function decode(payload) {
    if (!isObject(payload) || !Array.isArray(payload.pcs) || !Array.isArray(payload.days)) return null;
    const days = payload.days.map(text).slice(-DAYS);
    const pcs = [];
    for (const row of payload.pcs) {
      if (!isObject(row)) continue;
      const label = text(row.label);
      if (!LABEL_RE.test(label)) continue;
      const hours = Array.isArray(row.hours) ? row.hours.map(num).slice(-DAYS) : [];
      const phone = Array.isArray(row.phone) ? row.phone.map((p) => (isObject(p) ? { count: num(p.count), minutes: num(p.minutes) } : null)) : [];
      pcs.push({
        label,
        name: text(row.name).trim() || label,
        online: row.online === true,
        lastSeen: Number.isFinite(row.lastSeen) ? row.lastSeen : null,
        hours,
        phone: phone.at(-1) || { count: 0, minutes: 0 },
      });
    }
    return { now: Number.isFinite(payload.now) ? payload.now : Date.now(), days, pcs };
  }

  function ago(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 1) return "Just now";
    if (min < 60) return `${min}m ago`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  const hoursText = (h) => (h === 0 ? "0h" : h < 0.1 ? "<0.1h" : `${h.toFixed(1).replace(/\.0$/, "")}h`);
  const minutesText = (m) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`);

  function cell(content, className) {
    const td = document.createElement("td");
    if (className) td.className = className;
    td.textContent = content;
    return td;
  }

  function bar(hours, days) {
    const wrap = document.createElement("div");
    wrap.className = "bar";
    wrap.setAttribute("role", "img");
    wrap.setAttribute("aria-label", `${hoursText(hours.reduce((a, b) => a + b, 0))} online in ${DAYS} days`);
    for (let i = 0; i < DAYS; i += 1) {
      const h = Math.min(24, hours[i] || 0);
      const day = document.createElement("span");
      // A 12-hour day fills the bar.
      if (h > 0) day.style.height = `${Math.max(10, Math.round(Math.min(1, h / 12) * 100))}%`;
      day.title = `${days[i] || ""} ${hoursText(h)}`.trim();
      wrap.append(day);
    }
    return wrap;
  }

  function render(stats) {
    const table = $("team");
    const body = table.querySelector("tbody");
    body.replaceChildren();
    for (const pc of stats.pcs) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.className = "name";
      const dot = document.createElement("span");
      dot.className = pc.online ? "dot on" : "dot";
      dot.title = pc.online ? "Online" : "Offline";
      const label = document.createElement("span");
      label.textContent = pc.name;
      name.append(dot, label);
      const seen = pc.online ? "Online" : pc.lastSeen === null ? "-" : ago(Math.max(0, stats.now - pc.lastSeen));
      const today = pc.hours.at(-1) || 0;
      const graph = document.createElement("td");
      graph.append(bar(pc.hours, stats.days));
      const phone = pc.phone.count === 0 ? "-" : `${pc.phone.count} · ${minutesText(pc.phone.minutes)}`;
      tr.append(name, cell(seen, "quiet"), cell(hoursText(today), "num"), graph, cell(phone, "num"));
      body.append(tr);
    }
    table.hidden = stats.pcs.length === 0;
    say(stats.pcs.length === 0 ? EMPTY : "");
  }

  async function load(token) {
    const tz = -new Date().getTimezoneOffset();
    let response;
    try {
      response = await fetch(`https://relay.${config.base}/v1/team?tz=${tz}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
        credentials: "omit",
      });
    } catch {
      say(OFFLINE, "error");
      return;
    }
    if (response.status === 403) {
      say(NOT_OWNER, "error");
      return;
    }
    let stats = null;
    try {
      stats = response.ok ? decode(await response.json()) : null;
    } catch {}
    if (!stats) {
      say(OFFLINE, "error");
      return;
    }
    render(stats);
  }

  function signIn() {
    const slot = $("google");
    gis.initialize({
      client_id: config.clientId,
      callback: (response) => {
        const credential = isObject(response) ? text(response.credential) : "";
        if (!credential) return;
        slot.hidden = true;
        slot.replaceChildren();
        void load(credential);
      },
      auto_select: true,
      // popup returns the token to the callback. A redirect would post it to a URL.
      ux_mode: "popup",
    });
    gis.renderButton(slot, { type: "standard", theme: "filled_black", size: "large", text: "signin_with", width: 300 });
  }

  function googleId() {
    const google = globalThis.google;
    if (!google || !google.accounts || !google.accounts.id) return null;
    return google.accounts.id;
  }

  function whenGoogle() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const id = googleId();
        if (id) resolve(id);
        else if (Date.now() - started > 15000) reject(new Error("google"));
        else setTimeout(check, 50);
      };
      check();
    });
  }

  function run(id) {
    gis = id;
    config = readConfig();
    if (!config) {
      say(UNCONFIGURED, "error");
      return;
    }
    try {
      signIn();
    } catch {
      say(GOOGLE_DOWN, "error");
    }
  }

  const ready = googleId();
  if (ready) run(ready);
  else void whenGoogle().then(run).catch(() => say(GOOGLE_DOWN, "error"));
})();
