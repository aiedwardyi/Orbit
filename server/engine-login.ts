import { spawn, type ChildProcess } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

import { augmentedPath, resolveCliSpawn } from "./env-path.ts";
import { killCliTree } from "./procs.ts";

export interface LoginCapture {
  url?: string;
  code?: string;
}

type LoginState = "pending" | "complete" | "failed" | "cancelled";
interface LoginJob {
  generation: number;
  child?: ChildProcess;
  capture: LoginCapture;
  state: LoginState;
  done: Promise<void>;
  finish: (state: LoginState) => void;
  changed: Set<() => void>;
  acknowledged: boolean;
}

export class EngineLogin {
  private jobs = new Map<string, LoginJob>();
  private nextGeneration = 0;
  private disposed = false;
  private timeoutMs: number;
  private captureMs: number;

  constructor(timeoutMs = 5 * 60_000, captureMs = 10_000) {
    this.timeoutMs = timeoutMs;
    this.captureMs = captureMs;
  }

  state(engine: string): LoginState | undefined {
    return this.jobs.get(engine)?.state;
  }

  generation(engine: string): number | undefined {
    return this.jobs.get(engine)?.generation;
  }

  async wait(engine: string): Promise<void> {
    await this.jobs.get(engine)?.done;
  }

  capture(engine: string): LoginCapture {
    return { ...this.jobs.get(engine)?.capture };
  }

  needsRefresh(engine: string): boolean {
    const job = this.jobs.get(engine);
    return job?.state === "pending" || (job?.state === "complete" && !job.acknowledged);
  }

  async start(engine: string, cli: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<LoginCapture> {
    if (this.disposed) return {};
    let job = this.jobs.get(engine);
    if (job && job.state !== "pending") {
      await job.done;
      if (this.jobs.get(engine) === job) this.jobs.delete(engine);
      return this.start(engine, cli, args, env);
    }
    if (job?.state !== "pending") {
      job = this.create(engine);
      try {
        const resolved = resolveCliSpawn(cli, args);
        const child = spawn(resolved.command, resolved.args, {
          stdio: "pipe", windowsHide: true,
          ...(process.platform === "win32" ? {} : { detached: true }),
          env: { ...process.env, PATH: augmentedPath(), ...env },
        });
        job.child = child;
        child.stdin.on("error", () => {});
        this.read(child.stdout, job);
        this.read(child.stderr, job);
        child.once("error", () => job!.finish("failed"));
        child.once("close", (code) => job!.finish(code === 0 ? "complete" : "failed"));
      } catch {
        job.finish("failed");
      }
    }
    await this.waitForCapture(job);
    return { ...job.capture };
  }

  waitExternal(engine: string): LoginCapture {
    if (this.disposed) return {};
    if (this.state(engine) !== "pending") this.create(engine);
    return {};
  }

  complete(engine: string): void {
    const job = this.jobs.get(engine);
    if (job?.state === "pending") job.finish("complete");
  }

  acknowledge(engine: string, authenticated: boolean): void {
    const job = this.jobs.get(engine);
    if (job?.state === "complete") {
      job.acknowledged = true;
      if (!authenticated) job.state = "failed";
    }
  }

  clear(engine: string): void {
    this.jobs.delete(engine);
  }

  async cancel(engine: string): Promise<void> {
    const job = this.jobs.get(engine);
    if (!job) return;
    if (job.state === "pending") job.finish("cancelled");
    await job.done;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.jobs.keys()].map((engine) => this.cancel(engine)));
    this.jobs.clear();
  }

  private create(engine: string): LoginJob {
    let closed!: () => void;
    const job: LoginJob = {
      generation: ++this.nextGeneration,
      capture: {}, state: "pending", changed: new Set(), acknowledged: false,
      done: new Promise<void>((resolve) => { closed = resolve; }),
      finish: (state) => {
        if (job.state !== "pending") return;
        job.state = state;
        clearTimeout(timer);
        if (job.child && job.child.exitCode === null && job.child.signalCode === null) {
          job.child.once("close", closed);
          killCliTree(job.child);
        } else closed();
        for (const notify of job.changed) notify();
      },
    };
    const timer = setTimeout(() => job.finish("failed"), this.timeoutMs);
    timer.unref();
    this.jobs.set(engine, job);
    return job;
  }

  private read(stream: NodeJS.ReadableStream, job: LoginJob): void {
    let line = "";
    let dropping = false;
    stream.setEncoding("utf8");
    const parse = () => {
      if (job.state !== "pending") { line = ""; return; }
      const clean = stripVTControlCharacters(line).trim();
      const url = /^(?:(?:If your browser (?:did not|didn't) open, (?:navigate to this URL|visit)|If the browser didn't open, visit|Visit|Open(?: this URL)?|Sign in(?: at)?|URL|Verification (?:URL|URI))\s*:?\s*)?(https:\/\/[^\s<>"\x00-\x1f]+)$/i.exec(clean);
      const code = /^(?:(?:Enter (?:this |the )?(?:one-time |device |user )?code(?: \(expires in \d+ minutes\))?|(?:Your )?(?:one-time |device |user )?code)\s*:?\s*)?([A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,2})$/i.exec(clean);
      if (url && !job.capture.url) {
        try {
          const parsed = new URL(url[1]);
          if (!parsed.username && !parsed.password && !/[?&#](?:access_token|refresh_token|id_token|token|code)=/i.test(parsed.href)) job.capture.url = parsed.href;
        } catch {}
      }
      if (code && !job.capture.code) job.capture.code = code[1];
      for (const notify of job.changed) notify();
      line = "";
    };
    stream.on("data", (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r") {
          if (!dropping) parse();
          line = "";
          dropping = false;
        } else if (!dropping) {
          line += char;
          if (line.length > 8192) { line = ""; dropping = true; }
        }
      }
    });
    stream.on("end", () => { if (!dropping && line) parse(); line = ""; });
  }

  private waitForCapture(job: LoginJob): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        job.changed.delete(check);
        resolve();
      };
      const check = () => {
        if (job.state !== "pending" || (job.capture.url && job.capture.code)) finish();
      };
      const timer = setTimeout(finish, this.captureMs);
      job.changed.add(check);
      check();
    });
  }
}
