// How the composer should look while a turn is in flight.
//
// Rooms keep a real one-slot queue (PR 36): the placeholder says so, and
// send looks queued. 1:1 already POSTs mid-turn (steer-queue); lecturing
// the empty box about "the turn" made forever-chat feel like supervising
// an agent. Keep the queue; drop the gate-y chrome.
import { t, type MessageKey, type Translate } from "./i18n";

export interface ComposerBusyInput {
  busy: boolean;
  isRoom: boolean;
  canSteer: boolean;
  name: string;
  idlePlaceholder: string;
}

export interface ComposerBusyChrome {
  placeholder: string;
  /** Clock + muted send — rooms only, where a second Enter would drop a line. */
  sendLooksQueued: boolean;
  sendAriaKey: MessageKey;
  sendTitleKey: MessageKey;
}

export function composerBusyChrome(
  input: ComposerBusyInput,
  translate: Translate = t,
): ComposerBusyChrome {
  if (!input.busy) {
    return {
      placeholder: input.idlePlaceholder,
      sendLooksQueued: false,
      sendAriaKey: "composer.sendMessage",
      sendTitleKey: "composer.send",
    };
  }
  if (input.isRoom) {
    return {
      placeholder: translate("composer.queueHint", { name: input.name }),
      sendLooksQueued: true,
      sendAriaKey: "composer.queueMessage",
      sendTitleKey: "composer.sendsWhenFinished",
    };
  }
  return {
    placeholder: input.idlePlaceholder,
    sendLooksQueued: false,
    sendAriaKey: input.canSteer ? "composer.sendIntoTurn" : "composer.sendMessage",
    sendTitleKey: input.canSteer ? "composer.sendIntoTurn" : "composer.send",
  };
}
