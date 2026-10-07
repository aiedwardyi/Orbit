// Live PC sessions, their data channel pools, phones waiting on an empty
// pool, and spliced pairs (design sections 3 and 5).

import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import type { NoticeCode } from "../../shared/relay-protocol.ts";
import type { RelayLimits } from "./limits.ts";
import type { Logger } from "./log.ts";
import { ALERT_UNRECOGNIZED_NAME, peerPrefix, sendAlert } from "./net-util.ts";
import { splice, type SplicedPair } from "./splice.ts";

/** What the hub needs from a control channel. */
export interface ControlLink {
  notice(code: NoticeCode): void;
  want(n: number): void;
  close(): void;
}

export class Session {
  readonly id = randomBytes(16).toString("base64url");
  readonly poolToken = randomBytes(32).toString("base64url");
  readonly idle = new Set<TLSSocket>();
  readonly label: string;
  readonly since: number;
  readonly control: ControlLink;
  live = true;

  constructor(label: string, control: ControlLink, since: number) {
    this.label = label;
    this.control = control;
    this.since = since;
  }
}

interface WaitingPhone {
  socket: Socket;
  buffered: Buffer;
  peer: string;
  timer: NodeJS.Timeout;
}

export interface HubOptions {
  limits: RelayLimits;
  log: Logger;
  now?: () => number;
}

export type JoinResult = "parked" | "spliced" | "unknown-session" | "bad-token" | "pool-full";

export class Hub {
  private readonly byLabel = new Map<string, Session>();
  private readonly byId = new Map<string, Session>();
  private readonly waiting = new Map<string, WaitingPhone[]>();
  private waitingTotal = 0;
  private readonly splicedPerLabel = new Map<string, number>();
  private readonly pairs = new Set<LabeledPair>();
  /** Removes the parked-state listeners of an idle data channel. */
  private readonly parked = new WeakMap<TLSSocket, () => void>();
  /** label -> ms of the last online/offline change, for /v1/status. Insertion ordered, bounded. */
  private readonly changedAt = new Map<string, number>();
  private readonly opts: HubOptions;
  private splicesEmpty: (() => void) | null = null;
  private readonly now: () => number;
  draining = false;

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  get sessionCount(): number {
    return this.byLabel.size;
  }

  get splicedCount(): number {
    return this.pairs.size;
  }

  session(label: string): Session | undefined {
    return this.byLabel.get(label);
  }

  labelOf(sessionId: string): string | undefined {
    return this.byId.get(sessionId)?.label;
  }

  idleCount(label: string): number {
    return this.byLabel.get(label)?.idle.size ?? 0;
  }

  waitingCount(label: string): number {
    return this.waiting.get(label)?.length ?? 0;
  }

  canRegister(label: string): boolean {
    return this.byLabel.has(label) || this.byLabel.size < this.opts.limits.maxSessions;
  }

  /** Newest valid control connection wins; the old one is told `superseded`. */
  register(label: string, control: ControlLink): Session {
    const old = this.byLabel.get(label);
    const session = new Session(label, control, old ? old.since : this.now());
    // Map the new session first so phones waiting on the label survive the switch.
    this.byLabel.set(label, session);
    this.byId.set(session.id, session);
    if (old) this.end(old, "superseded");
    else this.markChanged(label);
    this.opts.log.log("session-up", { label, reason: old ? "superseded-old" : "new" });
    return session;
  }

  /** Ends a session: idle data channels close; waiting phones fail unless a newer session took over. */
  end(session: Session, code?: NoticeCode): void {
    if (!session.live) return;
    session.live = false;
    this.byId.delete(session.id);
    for (const socket of session.idle) socket.destroy();
    session.idle.clear();
    if (code) session.control.notice(code);
    session.control.close();
    if (this.byLabel.get(session.label) === session) {
      this.byLabel.delete(session.label);
      this.markChanged(session.label);
      this.failWaiting(session.label);
    }
    this.opts.log.log("session-down", { label: session.label, reason: code ?? "closed" });
  }

  /** Kills everything for a label: control, pool, waiting phones and live splices. */
  revoke(label: string): void {
    const session = this.byLabel.get(label);
    if (session) this.end(session, "revoked");
    for (const pair of this.pairsOf(label)) pair.destroy();
  }

  /** Checks a `join` and parks the channel, or splices it to a waiting phone. */
  join(sessionId: string, tokenOk: (session: Session) => boolean, socket: TLSSocket): JoinResult {
    const session = this.byId.get(sessionId);
    if (!session || !session.live) return "unknown-session";
    if (!tokenOk(session)) return "bad-token";
    const queue = this.waiting.get(session.label);
    const phone = queue?.shift();
    if (phone) {
      if (queue!.length === 0) this.waiting.delete(session.label);
      this.waitingTotal -= 1;
      clearTimeout(phone.timer);
      this.startSplice(session.label, phone.socket, socket, phone.buffered, phone.peer);
      return "spliced";
    }
    if (session.idle.size >= this.opts.limits.maxIdlePerLabel) return "pool-full";
    session.idle.add(socket);
    const unpark = () => session.idle.delete(socket);
    // A parked channel stays silent until `go`; anything else is a protocol error.
    const early = () => {
      this.opts.log.log("data-protocol-error", { label: session.label, reason: "bytes-before-go" });
      socket.destroy();
    };
    socket.once("close", unpark);
    socket.on("data", early);
    this.parked.set(socket, () => {
      socket.off("close", unpark);
      socket.off("data", early);
    });
    return "parked";
  }

  /** Routes a phone whose ClientHello named `label`. */
  dispatchPhone(label: string, phone: Socket, buffered: Buffer, peer: string): void {
    const session = this.byLabel.get(label);
    const log = this.opts.log;
    const peerLog = peerPrefix(peer);
    if (!session || this.draining) {
      log.log("phone-rejected", { label, peer: peerLog, reason: "offline" });
      sendAlert(phone, ALERT_UNRECOGNIZED_NAME);
      return;
    }
    if ((this.splicedPerLabel.get(label) ?? 0) + this.waitingCount(label) >= this.opts.limits.maxSplicedPerLabel) {
      log.log("phone-rejected", { label, peer: peerLog, reason: "label-limit" });
      phone.destroy();
      return;
    }
    const channel = session.idle.values().next().value;
    if (channel) {
      session.idle.delete(channel);
      this.startSplice(label, phone, channel, buffered, peer);
      return;
    }
    if (
      this.waitingCount(label) >= this.opts.limits.maxWaitingPerLabel ||
      this.waitingTotal >= this.opts.limits.maxWaitingTotal
    ) {
      log.log("phone-rejected", { label, peer: peerLog, reason: "wait-limit" });
      phone.destroy();
      return;
    }
    const entry: WaitingPhone = {
      socket: phone,
      buffered,
      peer,
      timer: setTimeout(() => {
        this.dropWaiting(label, entry);
        log.log("phone-rejected", { label, peer: peerLog, reason: "pool-timeout" });
        phone.destroy();
      }, this.opts.limits.phoneWaitMs),
    };
    phone.once("close", () => {
      clearTimeout(entry.timer);
      this.dropWaiting(label, entry);
    });
    const queue = this.waiting.get(label) ?? [];
    queue.push(entry);
    this.waiting.set(label, queue);
    this.waitingTotal += 1;
    session.control.want(queue.length);
  }

  status(label: string): LabelStatus {
    return { online: this.byLabel.has(label), since: this.changedAt.get(label) ?? null };
  }

  /** Splices for a label, so revocation can cut them. */
  pairsOf(label: string): SplicedPair[] {
    return [...this.pairs].filter((pair) => pair.label === label);
  }

  /** Shutdown step one: tell every PC `draining`, drop pools and waiting phones. */
  drain(): void {
    this.draining = true;
    for (const session of [...this.byLabel.values()]) this.end(session, "draining");
  }

  /** Resolves when no spliced pair is left, or after `timeoutMs`. */
  whenSplicesDone(timeoutMs: number): Promise<void> {
    if (this.pairs.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(finish, timeoutMs);
      const self = this;
      function finish() {
        clearTimeout(timer);
        self.splicesEmpty = null;
        resolve();
      }
      this.splicesEmpty = finish;
    });
  }

  /** Shutdown step two: cut spliced pairs still open after the grace period. */
  destroySplices(): void {
    for (const pair of [...this.pairs]) pair.destroy();
  }

  private startSplice(label: string, phone: Socket, data: TLSSocket, buffered: Buffer, peer: string): void {
    this.parked.get(data)?.();
    this.parked.delete(data);
    this.splicedPerLabel.set(label, (this.splicedPerLabel.get(label) ?? 0) + 1);
    const pair: LabeledPair = Object.assign(splice({
      phone,
      data,
      buffered,
      peer,
      idleMs: this.opts.limits.spliceIdleMs,
      now: this.now,
      onEnd: (stats) => {
        this.pairs.delete(pair);
        if (this.pairs.size === 0) this.splicesEmpty?.();
        const left = (this.splicedPerLabel.get(label) ?? 1) - 1;
        if (left > 0) this.splicedPerLabel.set(label, left);
        else this.splicedPerLabel.delete(label);
        this.opts.log.log("splice-end", { label, peer: peerPrefix(peer), ...stats });
      },
    }), { label });
    this.pairs.add(pair);
  }

  private dropWaiting(label: string, entry: WaitingPhone): void {
    const queue = this.waiting.get(label);
    const at = queue?.indexOf(entry) ?? -1;
    if (!queue || at < 0) return;
    queue.splice(at, 1);
    this.waitingTotal -= 1;
    if (queue.length === 0) this.waiting.delete(label);
  }

  private failWaiting(label: string): void {
    const queue = this.waiting.get(label);
    if (!queue) return;
    this.waiting.delete(label);
    for (const entry of queue) {
      clearTimeout(entry.timer);
      this.waitingTotal -= 1;
      sendAlert(entry.socket, ALERT_UNRECOGNIZED_NAME);
    }
  }

  private markChanged(label: string): void {
    this.changedAt.delete(label);
    this.changedAt.set(label, this.now());
    if (this.changedAt.size > this.opts.limits.maxStatusEntries) {
      this.changedAt.delete(this.changedAt.keys().next().value!);
    }
  }
}

type LabeledPair = SplicedPair & { label: string };

export interface LabelStatus {
  online: boolean;
  since: number | null;
}
