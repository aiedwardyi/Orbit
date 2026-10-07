// Read-only discovery and step execution. All cloud access goes through the
// injected Runner and Dns, so tests use fakes and never reach a provider.

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  NODE_SHA256,
  NODE_TARBALL,
  NODE_URL,
  OPERATOR_KEY_ARG,
  PUBLIC_RESOLVERS,
  PlanError,
  dnsName,
  describeStep,
  firewallNames,
  names,
  type AddressState,
  type DeployOptions,
  type DnsRecord,
  type IpRef,
  type ProjectState,
  type ResourceState,
  type Step,
} from "./plan.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  gcloud(args: string[]): Promise<RunResult>;
}

/** Registrar API access (name.com). */
export interface Dns {
  kind: "namecom";
  list(zone: string): Promise<DnsRecord[]>;
  create(zone: string, host: string, ip: string, ttl: number): Promise<void>;
  update(zone: string, id: number, host: string, ip: string, ttl: number): Promise<void>;
  remove(zone: string, id: number): Promise<void>;
}

/** No registrar API: reads the wildcard through public resolvers; the operator edits records by hand. */
export interface ManualDns {
  kind: "manual";
  list(zone: string): Promise<DnsRecord[]>;
}

export type DnsAccess = Dns | ManualDns;

export interface Local {
  build(): Promise<void>;
  fetchNode(): Promise<void>;
  writeConfig(opts: DeployOptions): Promise<void>;
  waitDns(fqdn: string, ip: string): Promise<void>;
  healthz(url: string): Promise<void>;
}

const NOT_FOUND = /was not found|notFound|404/;

/** The fields discovery reads from `gcloud ... describe --format=json`; gcloud omits unset ones. */
interface Described {
  address?: string;
  description?: string;
  networkTier?: string;
  region?: string;
  selfLink?: string;
  status?: string;
  users?: string[];
  networkInterfaces?: Array<{ accessConfigs?: Array<{ natIP?: string }> }>;
}

async function describe(runner: Runner, args: string[]): Promise<Described | null> {
  const res = await runner.gcloud([...args, "--format=json"]);
  if (res.code === 0) {
    // SAFETY: a successful describe prints one resource object; every Described field is optional and
    // each one read below is normalized (String, Array.isArray) or checked before use.
    return JSON.parse(res.stdout) as Described;
  }
  if (NOT_FOUND.test(res.stderr)) return null;
  throw new Error(`gcloud ${args.slice(0, 3).join(" ")} failed: ${res.stderr.trim().split("\n").pop()}`);
}

const lastPart = (url: string | undefined) => (url === undefined ? "" : url.split("/").pop()!);
const projectOf = (selfLink: string | undefined) => (selfLink === undefined ? "" : (/\/projects\/([^/]+)\//.exec(selfLink)?.[1] ?? ""));

/** Read-only: describes the named resources and lists DNS records. */
export async function discover(opts: DeployOptions, runner: Runner, dns: DnsAccess | null): Promise<ProjectState> {
  const n = names(opts);
  const scope = ["--project", opts.project];
  const a = await describe(runner, ["compute", "addresses", "describe", n.address, ...scope, "--region", opts.region]);
  const address: AddressState | null = a
    ? {
        name: n.address,
        project: projectOf(a.selfLink),
        region: lastPart(a.region),
        tier: String(a.networkTier ?? "PREMIUM"),
        ip: String(a.address ?? ""),
        status: String(a.status ?? ""),
        users: Array.isArray(a.users) ? a.users.map(String) : [],
        description: String(a.description ?? ""),
      }
    : null;
  const firewall: Record<string, ResourceState | null> = {};
  for (const name of firewallNames(opts)) {
    const f = await describe(runner, ["compute", "firewall-rules", "describe", name, ...scope]);
    firewall[name] = f ? { name, description: String(f.description ?? "") } : null;
  }
  const i = await describe(runner, ["compute", "instances", "describe", n.vm, ...scope, "--zone", opts.zone]);
  const nic = i?.networkInterfaces?.[0];
  const instance = i ? { name: n.vm, description: String(i.description ?? ""), ip: nic?.accessConfigs?.[0]?.natIP } : null;
  const { host } = dnsName(opts);
  const records = dns ? (await dns.list(opts.dnsZone)).filter((r) => r.host === host && r.type === "A") : [];
  return { address, firewall, instance, dns: records };
}

export interface ExecContext {
  runner: Runner;
  dns: DnsAccess;
  local: Local;
  /** Maps @build/ and @deploy/ placeholders to local paths. */
  buildDir: string;
  deployDir: string;
  out: (line: string) => void;
}

async function resolveIp(ctx: ExecContext, ref: IpRef): Promise<string> {
  if ("ip" in ref) return ref.ip;
  const { project, region, name } = ref.addressOf;
  const a = await describe(ctx.runner, ["compute", "addresses", "describe", name, "--project", project, "--region", region]);
  if (a?.address === undefined) throw new Error(`address ${name} has no IP`);
  return a.address;
}

function expand(ctx: ExecContext, opts: DeployOptions, arg: string): string {
  if (arg === OPERATOR_KEY_ARG) {
    if (!opts.operatorKeyFile) throw new PlanError("this step needs --operator-key <file>");
    return opts.operatorKeyFile;
  }
  if (arg.startsWith("@build/")) return join(ctx.buildDir, arg.slice(7));
  if (arg.startsWith("@deploy/")) return join(ctx.deployDir, arg.slice(8));
  return arg;
}

/** Runs steps in order and stops at the first failure. */
export async function execute(steps: Step[], opts: DeployOptions, ctx: ExecContext): Promise<void> {
  for (const [index, step] of steps.entries()) {
    ctx.out(`[${index + 1}/${steps.length}] ${describeStep(step)}`);
    switch (step.kind) {
      case "gcloud": {
        const res = await ctx.runner.gcloud(step.args.map((a) => expand(ctx, opts, a)));
        if (res.code !== 0) throw new Error(`step ${index + 1} failed: ${res.stderr.trim().split("\n").pop() ?? ""}`);
        break;
      }
      case "dns-upsert": {
        const ip = await resolveIp(ctx, step.value);
        const record = `A ${step.host} -> ${ip}, TTL ${step.ttl}`;
        if (step.manual || ctx.dns.kind === "manual") {
          const seen = (await ctx.dns.list(step.zone)).map((r) => r.answer);
          if (seen.length === 1 && seen[0] === ip) break;
          throw new Error(
            `manual DNS: ${step.fqdn} resolves to ${seen.join(", ") || "nothing"}, not ${ip}. ` +
              `Add this record in zone ${step.zone}, then re-run: ${record}`,
          );
        }
        const records = (await ctx.dns.list(step.zone)).filter((r) => r.host === step.host && r.type === "A");
        if (records.length > 1) throw new Error(`several A records at ${step.fqdn}; leave only ${record} by hand first`);
        if (records.length === 0) await ctx.dns.create(step.zone, step.host, ip, step.ttl);
        else if (records[0].answer !== ip) await ctx.dns.update(step.zone, records[0].id, step.host, ip, step.ttl);
        break;
      }
      case "dns-delete": {
        // Re-read now: a move has already pointed the record at the new IP.
        const keep = step.protect ? await resolveIp(ctx, step.protect) : null;
        if (step.manual || ctx.dns.kind === "manual") {
          if (step.onlyValue !== keep) {
            ctx.out(`  manual DNS: remove this record by hand in zone ${step.zone} if it exists: A ${step.host} -> ${step.onlyValue}`);
          }
          break;
        }
        const records = (await ctx.dns.list(step.zone)).filter(
          (r) => r.host === step.host && r.type === "A" && r.answer === step.onlyValue && r.answer !== keep,
        );
        for (const record of records) await ctx.dns.remove(step.zone, record.id);
        ctx.out(`  removed ${records.length} record(s)`);
        break;
      }
      case "local":
        if (step.action === "build") await ctx.local.build();
        else if (step.action === "fetch-node") await ctx.local.fetchNode();
        else if (step.action === "write-config") await ctx.local.writeConfig(opts);
        else if (step.action === "wait-dns") {
          const ip = await resolveIp(ctx, { addressOf: { project: opts.project, region: opts.region, name: names(opts).address } });
          await ctx.local.waitDns(`relay.${opts.base}`, ip);
        } else await ctx.local.healthz(`https://relay.${opts.base}/v1/healthz`);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Real implementations

const WIN_SAFE = /^[A-Za-z0-9 ._:/\\=,@~*+-]*$/;

/** gcloud through argv. On Windows gcloud is a .cmd, which needs a shell, so args are checked and quoted. */
export const gcloudRunner: Runner = {
  gcloud(args) {
    return new Promise((resolve, reject) => {
      const windows = process.platform === "win32";
      if (windows && !args.every((a) => WIN_SAFE.test(a))) {
        reject(new PlanError("argument has characters unsafe for cmd.exe"));
        return;
      }
      const child = windows
        ? spawn("gcloud.cmd", args.map((a) => (/[ ,=]/.test(a) ? `"${a}"` : a)), { shell: true, windowsHide: true })
        : spawn("gcloud", args);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c));
      child.stderr.on("data", (c: Buffer) => (stderr += c));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.end();
    });
  },
};

interface NameComRecord {
  host: string;
  type: "A";
  answer: string;
  ttl: number;
}

interface NameComList {
  records?: Array<{ id?: number; host?: string; type?: string; answer?: string }>;
  nextPage?: number;
}

/** name.com API v4 (endpoint shapes unverified against a live account). Credentials from env only. */
export function nameComDns(env: NodeJS.ProcessEnv = process.env): Dns {
  const user = env.NAMECOM_USER;
  const token = env.NAMECOM_TOKEN;
  if (!user || !token) throw new PlanError("set NAMECOM_USER and NAMECOM_TOKEN in the environment");
  const auth = `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
  const api = async (method: string, path: string, body?: NameComRecord): Promise<NameComList> => {
    const res = await fetch(`https://api.name.com/v4${path}`, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`name.com ${method} ${path.split("/").slice(0, 4).join("/")} -> ${res.status}`);
    // SAFETY: name.com v4 answers with a JSON object; list reads only the optional NameComList fields and normalizes them.
    return res.status === 204 ? {} : ((await res.json()) as NameComList);
  };
  return {
    kind: "namecom",
    async list(zone) {
      const out: DnsRecord[] = [];
      for (let page = 1; page <= 50; page++) {
        const res = await api("GET", `/domains/${zone}/records?perPage=1000&page=${page}`);
        const records = res.records ?? [];
        for (const r of records) {
          out.push({ id: Number(r.id), host: String(r.host ?? ""), type: String(r.type), answer: String(r.answer) });
        }
        if (!res.nextPage) break;
      }
      return out;
    },
    async create(zone, host, ip, ttl) {
      await api("POST", `/domains/${zone}/records`, { host, type: "A", answer: ip, ttl });
    },
    async update(zone, id, host, ip, ttl) {
      await api("PUT", `/domains/${zone}/records/${id}`, { host, type: "A", answer: ip, ttl });
    },
    async remove(zone, id) {
      await api("DELETE", `/domains/${zone}/records/${id}`);
    },
  };
}

export type Resolve4 = (server: string, fqdn: string) => Promise<string[]>;

async function publicResolve4(server: string, fqdn: string): Promise<string[]> {
  const { Resolver } = await import("node:dns/promises");
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  resolver.setServers([server]);
  return resolver.resolve4(fqdn).catch(() => []);
}

/**
 * Manual DNS: the wildcard is read by resolving a random name under <base> at each public resolver,
 * so a cached answer for one name cannot pass for the record. Never calls a registrar.
 */
export function manualDns(opts: Pick<DeployOptions, "base" | "dnsZone">, resolve4: Resolve4 = publicResolve4): ManualDns {
  const { host } = dnsName(opts);
  return {
    kind: "manual",
    async list() {
      const fqdn = `probe-${randomBytes(6).toString("hex")}.${opts.base}`;
      const answers = new Set<string>();
      for (const server of PUBLIC_RESOLVERS) for (const ip of await resolve4(server, fqdn)) answers.add(ip);
      return [...answers].map((answer) => ({ id: 0, host, type: "A", answer }));
    },
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** The acme block of the relay config, keys in the order the config file lists them. */
interface AcmeConfig {
  directoryUrl: string;
  email?: string;
  termsOfServiceAgreed?: true;
}

export function realLocal(relayDir: string, buildDir: string): Local {
  return {
    async build() {
      await mkdir(buildDir, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [join(relayDir, "scripts", "build.mjs")], { stdio: "inherit" });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("build failed; run pnpm install in relay/"))));
      });
      await writeFile(join(buildDir, "wink-relay.mjs"), await readFile(join(relayDir, "dist", "wink-relay.mjs")));
    },
    async fetchNode() {
      await mkdir(buildDir, { recursive: true });
      const target = join(buildDir, NODE_TARBALL);
      const exists = await stat(target).then(() => true, () => false);
      if (!exists) {
        const res = await fetch(NODE_URL);
        if (!res.ok || !res.body) throw new Error(`download ${NODE_URL} -> ${res.status}`);
        const tmp = `${target}.part`;
        // SAFETY: fetch's body is a WHATWG ReadableStream of bytes; the lib.dom and node:stream/web typings differ only nominally.
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
        await rename(tmp, target);
      }
      const digest = await sha256File(target);
      if (digest !== NODE_SHA256) {
        await rm(target, { force: true });
        throw new Error(`${NODE_TARBALL} sha256 mismatch; refusing to deploy it`);
      }
    },
    async writeConfig(opts) {
      await mkdir(buildDir, { recursive: true });
      const acme: AcmeConfig = { directoryUrl: opts.acmeDirectory };
      if (opts.acmeEmail) acme.email = opts.acmeEmail;
      acme.termsOfServiceAgreed = true;
      const config = {
        base: opts.base,
        listen: { host: "::", port: 443 },
        dataDir: "/var/lib/wink-relay",
        revokedLabelsFile: "/etc/wink-relay/revoked-labels",
        acme,
      };
      await writeFile(join(buildDir, "wink-relay.config.json"), `${JSON.stringify(config, null, 2)}\n`);
    },
    async waitDns(fqdn, ip) {
      const { Resolver } = await import("node:dns/promises");
      const resolver = new Resolver();
      resolver.setServers(["8.8.8.8", "1.1.1.1"]);
      for (let attempt = 0; attempt < 60; attempt++) {
        const got = await resolver.resolve4(fqdn).catch((): string[] => []);
        if (got.length === 1 && got[0] === ip) return;
        await new Promise((r) => setTimeout(r, 10_000));
      }
      throw new Error(`${fqdn} did not resolve to ${ip} within 10 minutes`);
    },
    async healthz(url) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const ok = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then((r) => r.ok, () => false);
        if (ok) return;
        await new Promise((r) => setTimeout(r, 15_000));
      }
      throw new Error(`${url} did not become healthy`);
    },
  };
}
