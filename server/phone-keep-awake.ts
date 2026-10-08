import type { PhoneAccess } from "./phone-access.ts";

export interface PhoneKeepAwakeMessage {
  type: "wink:phone-keep-awake";
  on: boolean;
}

interface PhoneKeepAwakePort {
  postMessage(message: PhoneKeepAwakeMessage): void;
}

export function postPhoneKeepAwake(access: Pick<PhoneAccess, "keepAwake">, parentPort?: PhoneKeepAwakePort): void {
  parentPort?.postMessage({ type: "wink:phone-keep-awake", on: access.keepAwake() });
}
