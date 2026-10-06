import { openBlankTerminal, openSignInTerminal } from "./terminal-launch.mjs";

export async function openEngineSignIn(instanceId, { resolve, copy, open = openSignInTerminal, blank = openBlankTerminal }) {
  if (Object.prototype.toString.call(instanceId) !== "[object String]" || !/^[\w.-]+$/.test(instanceId)) throw new Error("Invalid engine id");
  const signIn = await resolve(instanceId);
  if (!signIn?.command) throw new Error("Unknown engine sign-in");
  if (!/\bYOUR_[A-Z0-9_]+\b/.test(signIn.command) && await open(signIn)) return "running";
  copy(signIn.command);
  return await blank() ? "opened" : "copied";
}
