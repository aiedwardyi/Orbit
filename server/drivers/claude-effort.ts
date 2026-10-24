// Effort moved into a running Claude turn: the CLI applies apply_flag_settings
// at once, mid-turn too, so the turn's next model call carries it.
import type { EffortLevel } from "../contracts.ts";
import { newId } from "../contracts.ts";

export type EffortRequest = ReturnType<typeof effortRequest>;

const effortRequest = (requestId: string, effort: EffortLevel) => ({
  type: "control_request" as const,
  request_id: requestId,
  request: { subtype: "apply_flag_settings" as const, settings: { effortLevel: effort } },
});

/** The spawn contract a process switched to this effort now matches; one
 * spawned without --effort matches none, so its next turn relaunches. */
const keyWithEffort = (argsKey: string, effort: EffortLevel): string => {
  if (!argsKey) return "";
  const key: { args: string[] } = JSON.parse(argsKey);
  const at = key.args.indexOf("--effort");
  if (at === -1) return "";
  key.args[at + 1] = effort;
  return JSON.stringify(key);
};

/** True once the CLI answers success within ms. A success that comes later
 * still moves the session's contract, since the CLI did switch. */
export function switchEffort(
  session: {
    argsKey: string;
    replies: Map<string, (ok: boolean) => void>;
    turn: { launch?: { request: { effort?: EffortLevel } } } | null;
  },
  effort: EffortLevel,
  write: (request: EffortRequest) => Promise<boolean>,
  ms: number,
): Promise<boolean> {
  const requestId = newId();
  const turn = session.turn;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    session.replies.set(requestId, (ok) => {
      session.replies.delete(requestId);
      clearTimeout(timer);
      if (ok) {
        session.argsKey = keyWithEffort(session.argsKey, effort);
        // a relaunch of this turn replays its launch request
        if (turn?.launch) turn.launch.request = { ...turn.launch.request, effort };
      }
      resolve(ok);
    });
    void write(effortRequest(requestId, effort)).then((written) => {
      if (!written) session.replies.get(requestId)?.(false);
    });
  });
}
