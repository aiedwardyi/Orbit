// Phone sign-in at the one registered Google origin. The PC-bound token
// leaves this page only in the fragment of the PC it was bound to.
(() => {
  // 16 chars, lowercase base32, same alphabet as relay labels.
  const LABEL_RE = /^[a-z2-7]{16}$/;
  const M_RE = /^[A-Za-z0-9_-]{43}$/;
  const CLIENT_RE = /^[0-9A-Za-z_-]+(?:\.[0-9A-Za-z_-]+)*\.apps\.googleusercontent\.com$/;
  const BASE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  const LAST_PC = "wink-signin-pc";
  const EMPTY = "Sign in with Google in Wink on your PC first: Settings, Sync.";
  const OFFLINE = "Could not reach your PC. Check your connection and try again.";
  const BAD_LINK = "That PC link is not valid.";
  const NOT_YOURS = "That PC is not signed in to this Google account.";
  const UNCONFIGURED = "Sign-in is not configured.";
  const GOOGLE_DOWN = "Could not load Google sign-in. Check your connection and try again.";

  let gis = null;
  let config = null;

  const $ = (id) => document.getElementById(id);
  const say = (text, tone) => {
    const status = $("status");
    status.textContent = text;
    status.className = tone ? `status ${tone}` : "status";
  };
  const text = (value) => (Object.prototype.toString.call(value) === "[object String]" ? value : "");

  function b64url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }

  function randomNonce() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return b64url(bytes);
  }

  // Null bytes keep the label and m from sliding into each other.
  async function boundNonce(pc, m) {
    const data = new TextEncoder().encode(`wink-gpair/1\0${pc}\0${m}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return b64url(digest);
  }

  function readConfig() {
    const raw = globalThis.WINK_SIGNIN;
    if (Object.prototype.toString.call(raw) !== "[object Object]") return null;
    const clientId = text(raw.clientId);
    const base = text(raw.base);
    if (!CLIENT_RE.test(clientId) || !BASE_RE.test(base)) return null;
    return { clientId, base };
  }

  function remembered() {
    try {
      return localStorage.getItem(LAST_PC) || "";
    } catch {
      return "";
    }
  }

  function remember(label) {
    try {
      localStorage.setItem(LAST_PC, label);
    } catch {}
  }

  function decodePcs(payload) {
    if (!Array.isArray(payload)) return null;
    const pcs = [];
    for (const row of payload) {
      if (Object.prototype.toString.call(row) !== "[object Object]") continue;
      const label = text(row.label);
      if (!LABEL_RE.test(label)) continue;
      const name = text(row.name).trim();
      pcs.push({ label, name: name || label });
    }
    return pcs;
  }

  async function loadPcs(token) {
    try {
      const response = await fetch(`https://relay.${config.base}/v1/pcs`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok) return null;
      return decodePcs(await response.json());
    } catch {
      return null;
    }
  }

  function go(label, suffix) {
    if (!LABEL_RE.test(label)) {
      say(BAD_LINK, "error");
      return;
    }
    remember(label);
    location.assign(`https://${label}.${config.base}/pair${suffix}`);
  }

  function showList(pcs) {
    say("Choose a PC.");
    const list = $("list");
    list.hidden = false;
    list.replaceChildren();
    const sorted = pcs.slice().sort((a, b) => a.name.localeCompare(b.name) || a.label.localeCompare(b.label));
    for (const pc of sorted) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = pc.name;
      button.addEventListener("click", () => go(pc.label, "?g=1"));
      list.append(button);
    }
  }

  function choose(pcs) {
    if (pcs.length === 0) {
      say(EMPTY);
      return;
    }
    if (pcs.length === 1) {
      go(pcs[0].label, "?g=1");
      return;
    }
    const hit = pcs.find((pc) => pc.label === remembered());
    if (hit) {
      go(hit.label, "?g=1");
      return;
    }
    showList(pcs);
  }

  function credentialFrom(response) {
    if (Object.prototype.toString.call(response) !== "[object Object]") return "";
    return text(response.credential);
  }

  function promptFailed(moment) {
    try {
      if (moment.isDismissedMoment() && moment.getDismissedReason() === "credential_returned") return false;
      return moment.isNotDisplayed() || moment.isSkippedMoment() || moment.isDismissedMoment();
    } catch {
      return true;
    }
  }

  function hideGoogle() {
    const slot = $("google");
    if (!slot) return;
    slot.hidden = true;
    slot.replaceChildren();
  }

  function requestToken(nonce, autoSelect) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buttonShown = false;
      const finish = (credential) => {
        if (settled || !credential) return;
        settled = true;
        hideGoogle();
        resolve(credential);
      };
      const showButton = () => {
        if (settled || buttonShown) return;
        const slot = $("google");
        if (!slot) return;
        buttonShown = true;
        slot.hidden = false;
        slot.replaceChildren();
        gis.renderButton(slot, {
          type: "standard",
          theme: "filled_black",
          size: "large",
          text: "signin_with",
          width: 300,
        });
      };
      try {
        gis.cancel();
        gis.initialize({
          client_id: config.clientId,
          callback: (response) => finish(credentialFrom(response)),
          nonce,
          auto_select: autoSelect,
          // popup returns the token to the callback. A redirect would post it to a URL.
          ux_mode: "popup",
        });
      } catch (error) {
        reject(error);
        return;
      }
      if (!autoSelect) {
        showButton();
        return;
      }
      try {
        gis.prompt((moment) => {
          if (!settled && promptFailed(moment)) showButton();
        });
      } catch {
        showButton();
      }
    });
  }

  async function coldStart() {
    const token = await requestToken(randomNonce(), false);
    const listed = await loadPcs(token);
    if (!listed) {
      say(OFFLINE, "error");
      return;
    }
    choose(listed);
  }

  async function returnLeg(pc, m) {
    const directoryToken = await requestToken(randomNonce(), true);
    const listed = await loadPcs(directoryToken);
    if (!listed) {
      say(OFFLINE, "error");
      return;
    }
    if (!listed.some((row) => row.label === pc)) {
      say(NOT_YOURS, "error");
      return;
    }
    const pcToken = await requestToken(await boundNonce(pc, m), true);
    go(pc, `#g=${encodeURIComponent(pcToken)}`);
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
        if (id) {
          resolve(id);
          return;
        }
        if (Date.now() - started > 15000) {
          reject(new Error("google"));
          return;
        }
        setTimeout(check, 50);
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
    const params = new URLSearchParams(location.search);
    const pc = params.get("pc");
    const m = params.get("m");
    if (pc === null && m === null) {
      void coldStart();
      return;
    }
    if (pc === null || m === null || !LABEL_RE.test(pc) || !M_RE.test(m)) {
      say(BAD_LINK, "error");
      return;
    }
    void returnLeg(pc, m);
  }

  const ready = googleId();
  if (ready) run(ready);
  else void whenGoogle().then(run).catch(() => say(GOOGLE_DOWN, "error"));
})();
