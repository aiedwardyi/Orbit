// Packaged-system copy and native dialogs. The renderer has its own catalog;
// this module only needs the strings the main process paints before (or
// without) the React tree. Preference is stored in userData so an explicit
// Settings choice survives the boot-failure page.
import fs from "node:fs";
import path from "node:path";

export const LOCALE_IDS = ["en", "ko"];
export const LOCALE_PREFERENCES = ["system", "en", "ko"];

const en = {
  "packaged.bootTitle": "Couldn't start the bot server",
  "packaged.bootPorts": "Every Orbit port answered health checks from another process. Quit the other copy or program, then reopen Orbit.",
  "packaged.bootTimeout": "The background server did not start in time. Quit and reopen Orbit.",
  "packaged.bootCheckLog": "If it keeps happening, check the server log.",
  "packaged.desktopUnavailable": "Desktop unavailable",
  "packaged.liveDesktopFailed": "Couldn't open the live desktop",
  "packaged.openInBrowser": "Open in browser",
  "packaged.liveDesktop": "Live desktop",
  "packaged.chooseFolder": "Choose a working folder",
  "packaged.exportDiagnostics": "Export diagnostics",
  "packaged.saveWhere": "Where do you want to save it?",
  "packaged.save": "Save",
  "native.copyLink": "Copy Link",
  "native.undo": "Undo",
  "native.redo": "Redo",
  "native.cut": "Cut",
  "native.copy": "Copy",
  "native.paste": "Paste",
  "native.pasteMatch": "Paste and Match Style",
  "native.selectAll": "Select All",
};

const ko = {
  "packaged.bootTitle": "봇 서버를 시작하지 못했습니다",
  "packaged.bootPorts": "Orbit 포트가 모두 다른 프로세스의 상태 확인에 응답했습니다. 다른 복사본이나 프로그램을 종료한 뒤 Orbit를 다시 여세요.",
  "packaged.bootTimeout": "백그라운드 서버가 제시간에 시작되지 않았습니다. Orbit를 종료한 뒤 다시 여세요.",
  "packaged.bootCheckLog": "문제가 계속되면 서버 로그를 확인하세요.",
  "packaged.desktopUnavailable": "데스크톱을 사용할 수 없음",
  "packaged.liveDesktopFailed": "실시간 데스크톱을 열지 못했습니다",
  "packaged.openInBrowser": "브라우저에서 열기",
  "packaged.liveDesktop": "실시간 데스크톱",
  "packaged.chooseFolder": "작업 폴더 선택",
  "packaged.exportDiagnostics": "진단 내보내기",
  "packaged.saveWhere": "어디에 저장할까요?",
  "packaged.save": "저장",
  "native.copyLink": "링크 복사",
  "native.undo": "실행 취소",
  "native.redo": "다시 실행",
  "native.cut": "잘라내기",
  "native.copy": "복사",
  "native.paste": "붙여넣기",
  "native.pasteMatch": "붙여넣고 서식 맞추기",
  "native.selectAll": "모두 선택",
};

const catalogs = { en, ko };
const FILE = "locale-preference.json";

export function detectLocale(tag) {
  const lower = String(tag ?? "").trim().toLowerCase().replaceAll("_", "-");
  if (lower === "ko" || lower.startsWith("ko-") || lower === "kor" || lower.startsWith("kor-")) {
    return "ko";
  }
  return "en";
}

export function isPreference(value) {
  return LOCALE_PREFERENCES.includes(value);
}

export function preferencePath(userDataDir) {
  return path.join(userDataDir, FILE);
}

export function readPreference(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferencePath(userDataDir), "utf8"));
    if (isPreference(parsed?.preference)) return parsed.preference;
  } catch {
    /* missing or unreadable — follow the OS */
  }
  return "system";
}

export function writePreference(userDataDir, preference) {
  if (!isPreference(preference)) return readPreference(userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(preferencePath(userDataDir), `${JSON.stringify({ preference })}\n`, "utf8");
  return preference;
}

export function resolveLocale(preference, osTag) {
  if (preference === "en" || preference === "ko") return preference;
  return detectLocale(osTag);
}

export function translate(locale, key, vars) {
  const table = catalogs[locale] ?? catalogs.en;
  let phrase = table[key] ?? catalogs.en[key] ?? key;
  if (!vars) return phrase;
  for (const [name, value] of Object.entries(vars)) {
    phrase = phrase.replaceAll(`{${name}}`, String(value));
  }
  return phrase;
}

export function uiFontStack() {
  return "-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif";
}

export { en, ko };
