import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ERROR_SITES, makeErrorReport, validErrorReport } from "../shared/error-report.mjs";
import { errorReportEndpoint, postErrorReport } from "./error-report-transport.mjs";

const DAY = 86400000;
const TTL = 7 * DAY;
const MAX_BYTES = 200 * 1024;

function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function read(file) {
  try {
    if (fs.statSync(file).size <= MAX_BYTES) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  return null;
}

export function errorReportDsn(readBaked) {
  try {
    const value = readBaked();
    if (typeof value?.dsn === "string") return value.dsn;
  } catch {}
  return "";
}

export function createErrorReports({ userData, dsn, build, platform, arch, now = Date.now, uptime = process.uptime }) {
  const pref = path.join(userData, "error-report-consent.json");
  const queue = path.join(userData, "error-report-queue.json");
  // Opt-out purges reports, but must not reset the daily upload limit.
  const budget = path.join(userData, "error-report-budget.json");
  const marker = path.join(userData, "error-report-active");
  const endpoint = errorReportEndpoint(dsn);
  let state = read(queue) ?? {};
  let records = Array.isArray(state.records) ? state.records : [];
  state = { ...state, ...read(budget) };
  let timer;
  let active;
  let pending;
  let started = false;
  let stopped = false;
  let dirty = false;
  const consent = () => {
    const value = read(pref);
    return value?.schema === 1 && value.enabled === true;
  };
  const purge = () => {
    active?.abort();
    records = [];
    dirty = false;
    fs.rmSync(queue, { force: true });
    fs.rmSync(marker, { force: true });
  };
  const enabled = () => {
    if (stopped) return false;
    if (endpoint && consent()) return true;
    purge();
    return false;
  };
  const trim = () => {
    const time = now();
    records = records.filter((item) => validErrorReport(item?.report)
      && Number.isFinite(item.created) && item.created > time - TTL && item.created <= time
      && Number.isInteger(item.attempts) && item.attempts >= 0 && item.attempts <= 35
      && Number.isFinite(item.next) && item.next >= 0 && item.next <= time + TTL)
      .map(({ report, created, attempts, next }) => ({ report, created, attempts, next }));
    const day = Math.floor(time / DAY);
    state = { day, uploads: state.day === day && Number.isInteger(state.uploads) ? Math.max(0, Math.min(5, state.uploads)) : 0, nextUpload: Number.isFinite(state.nextUpload) ? Math.max(0, Math.min(time + TTL, state.nextUpload)) : 0 };
    records = records.slice(-100);
  };
  const save = () => {
    atomic(budget, state);
    atomic(queue, { records });
    dirty = false;
  };
  const capture = (input) => {
    try {
      if (!enabled()) return;
      trim();
      const report = makeErrorReport(input, { build, platform, arch, now: now(), uptime: uptime(), reportId: randomBytes(16).toString("hex") });
      if (!report) return;
      const existing = records.find((item) => !item.attempts && item.report.code === report.code && item.report.site === report.site && item.report.build === report.build && item.report.platform === report.platform);
      if (existing) existing.report.count = Math.min(10000, existing.report.count + 1);
      else records = [...records, { report, created: now(), attempts: 0, next: now() }].slice(-100);
      dirty = true;
    } catch {}
  };
  const flushOne = async () => {
    try {
      if (!enabled()) return;
      const size = records.length;
      trim();
      if (records.length !== size) dirty = true;
      const item = records.find((record) => record.next <= now());
      if (!item || state.uploads >= 5 || state.nextUpload > now()) {
        if (dirty) save();
        return;
      }
      item.attempts += 1;
      state.uploads += 1;
      const backoff = Math.min(6 * 3600000, 30000 * 2 ** (item.attempts - 1) * (1 + Math.random() * 0.25));
      item.next = now() + backoff;
      state.nextUpload = item.next;
      // Persist the attempt before opening a socket; outcomes wait for the next flush or quit.
      save();
      active = new AbortController();
      const result = await postErrorReport(endpoint, item.report, active.signal);
      if (!enabled()) return;
      if (result.status >= 200 && result.status < 300 || result.status >= 300 && result.status < 500 && ![408, 429].includes(result.status)) {
        records = records.filter((record) => record.report.reportId !== item.report.reportId);
        state.nextUpload = 0;
      } else {
        const delay = /^\d+$/.test(result.retryAfter ?? "") ? Number(result.retryAfter) * 1000 : Date.parse(result.retryAfter ?? "") - now();
        if (Number.isFinite(delay) && delay > 0) item.next = Math.max(item.next, Math.min(now() + TTL, now() + delay));
        const retained = records.find((record) => record.report.reportId === item.report.reportId);
        if (retained) retained.next = item.next;
        state.nextUpload = item.next;
      }
      dirty = true;
    } catch {} finally {
      active = null;
    }
  };
  const flush = () => pending ??= flushOne().finally(() => { pending = null; });
  const mark = () => { if (started && enabled()) atomic(marker, 1); };
  try { enabled(); } catch {}
  return {
    consent, capture, flush, available: () => Boolean(endpoint),
    setConsent(value) {
      if (typeof value !== "boolean") throw new Error("Invalid error report consent");
      atomic(pref, { schema: 1, enabled: value });
      try {
        if (!value) purge();
        else mark();
      } catch {}
      return consent();
    },
    start() {
      if (started) return;
      started = true;
      try {
        if (enabled()) {
          if (fs.existsSync(marker)) capture({ process: "main", code: "UNCLEAN_EXIT", site: ERROR_SITES.uncleanExit });
          mark();
        }
      } catch {}
      timer = setInterval(() => void flush(), 30000);
      timer.unref();
    },
    stop() {
      try { if (dirty && enabled()) { trim(); save(); } } catch {}
      stopped = true;
      clearInterval(timer);
      active?.abort();
      try { fs.rmSync(marker, { force: true }); } catch {}
    },
  };
}
