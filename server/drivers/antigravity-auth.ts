import { execFile, type ExecFileException, type ExecFileOptionsWithStringEncoding } from "node:child_process";

import { cachedSignIn } from "./auth-status.ts";

type KeyringExec = (file: string, args: string[], options: ExecFileOptionsWithStringEncoding, done: (error: ExecFileException | null, stdout: string) => void) => void;

export function probeAntigravitySignIn(platform = process.platform, run: KeyringExec = execFile): Promise<boolean | undefined> {
  if (platform !== "win32" && platform !== "darwin") return Promise.resolve(undefined);
  const file = platform === "win32" ? "cmdkey.exe" : "security";
  const args = platform === "win32" ? ["/list"] : ["find-generic-password", "-s", "gemini", "-a", "antigravity"];
  return new Promise((resolve) => {
    run(file, args, { windowsHide: true, timeout: 3000, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        resolve(platform === "darwin" && error.code === 44 ? false : undefined);
        return;
      }
      resolve(platform === "darwin" || /(?:^|\s)LegacyGeneric:target=gemini:antigravity\s*$/m.test(stdout));
    });
  });
}

export function antigravitySignIn(probe = probeAntigravitySignIn) {
  let revision = 0;
  let applied = 0;
  let authenticated: boolean | undefined;
  const check = cachedSignIn(async () => {
    const started = ++revision;
    const result = await probe();
    if (result !== undefined && started > applied) {
      applied = started;
      authenticated = result;
    }
    return result;
  });
  return {
    async check(refresh = false) {
      await check(refresh);
      return authenticated;
    },
    record(signedIn: boolean) {
      applied = ++revision;
      authenticated = signedIn;
    },
  };
}
