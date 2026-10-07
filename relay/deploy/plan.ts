// Deployment planner for the relay VM (design section 13). Pure: takes
// options and discovered state, returns ordered steps. Nothing here talks to
// a cloud API. Runs on plain Node 24 (type stripping), so no dependencies.

export const NODE_VERSION = "24.21.0";
/** sha256 of node-v24.21.0-linux-x64.tar.xz from nodejs.org SHASUMS256.txt. */
export const NODE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";
export const NODE_TARBALL = `node-v${NODE_VERSION}-linux-x64.tar.xz`;
export const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}`;

/** Google IAP TCP forwarding source range, the only allowed SSH source. */
export const IAP_RANGE = "35.235.240.0/20";
export const DNS_TTL = 300;

export type Tier = "STANDARD" | "PREMIUM";

export interface DeployOptions {
  project: string;
  region: string;
  zone: string;
  tier: Tier;
  base: string;
  /** DNS zone at the provider; base must equal it or sit under it. */
  dnsZone: string;
  prefix: string;
  machine: string;
  operatorKeyFile?: string;
  acmeDirectory: string;
  acmeEmail?: string;
  acceptAcmeTerms: boolean;
}

export interface AddressState {
  name: string;
  project: string;
  region: string;
  tier: string;
  ip: string;
  status: string;
  users: string[];
  description: string;
}

export interface ResourceState {
  name: string;
  description: string;
  ip?: string;
}

export interface DnsRecord {
  id: number;
  host: string;
  type: string;
  answer: string;
}

export interface ProjectState {
  address: AddressState | null;
  firewall: Record<string, ResourceState | null>;
  instance: ResourceState | null;
  dns: DnsRecord[];
}

export type IpRef = { ip: string } | { addressOf: { project: string; region: string; name: string } };

export type Step =
  | { kind: "gcloud"; args: string[]; mutates: boolean; stdinFile?: string; note?: string }
  | { kind: "dns-upsert"; zone: string; host: string; fqdn: string; value: IpRef; ttl: number }
  | { kind: "dns-delete"; zone: string; host: string; fqdn: string; onlyValue: string; protect?: IpRef }
  | { kind: "local"; action: "build" | "fetch-node" | "write-config" | "wait-dns" | "healthz"; detail: string };

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION_RE = /^[a-z]+-[a-z]+[0-9]{1,2}$/;
const PREFIX_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const MACHINE_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const BASE_RE = /^(?=.{4,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function validate(opts: DeployOptions): void {
  if (!PROJECT_RE.test(opts.project)) throw new PlanError("invalid --project");
  if (!REGION_RE.test(opts.region)) throw new PlanError("invalid --region");
  if (!new RegExp(`^${opts.region}-[a-z]$`).test(opts.zone)) throw new PlanError("--zone must be in --region");
  if (opts.tier !== "STANDARD" && opts.tier !== "PREMIUM") throw new PlanError("--network-tier is STANDARD or PREMIUM");
  if (!BASE_RE.test(opts.base)) throw new PlanError("invalid --base");
  if (!BASE_RE.test(opts.dnsZone)) throw new PlanError("invalid --dns-zone");
  if (opts.base !== opts.dnsZone && !opts.base.endsWith(`.${opts.dnsZone}`)) {
    throw new PlanError("--base must be --dns-zone or a name under it");
  }
  if (!PREFIX_RE.test(opts.prefix)) throw new PlanError("invalid --prefix");
  if (!MACHINE_RE.test(opts.machine)) throw new PlanError("invalid --machine");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/[A-Za-z0-9._~\/-]*$/.test(opts.acmeDirectory)) {
    throw new PlanError("invalid --acme-directory");
  }
  if (opts.acmeEmail && !/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(opts.acmeEmail)) throw new PlanError("invalid --acme-email");
}

export function names(opts: Pick<DeployOptions, "prefix">) {
  return {
    address: `${opts.prefix}-ip`,
    vm: `${opts.prefix}-vm`,
    fw443: `${opts.prefix}-allow-443`,
    fw22: `${opts.prefix}-allow-iap-22`,
    tag: opts.prefix,
  };
}

/** Marker in the description of every resource this service creates. */
export const ownerMarker = (base: string) => `wink-relay-owned:${base}`;

/** The wildcard record: relative host at the provider and its FQDN. */
export function dnsName(opts: Pick<DeployOptions, "base" | "dnsZone">): { host: string; fqdn: string } {
  const sub = opts.base === opts.dnsZone ? "" : opts.base.slice(0, -(opts.dnsZone.length + 1));
  return { host: sub ? `*.${sub}` : "*", fqdn: `*.${opts.base}` };
}

const g = (args: string[], mutates: boolean, note?: string): Step => ({ kind: "gcloud", args, mutates, note });

function where(opts: DeployOptions, scope: "region" | "zone" | "global"): string[] {
  if (scope === "region") return ["--project", opts.project, "--region", opts.region];
  if (scope === "zone") return ["--project", opts.project, "--zone", opts.zone];
  return ["--project", opts.project];
}

const ssh = (opts: DeployOptions, command: string, stdinFile?: string): Step => ({
  kind: "gcloud",
  args: ["compute", "ssh", names(opts).vm, ...where(opts, "zone"), "--tunnel-through-iap", "--command", command],
  mutates: true,
  stdinFile,
});

/** Throws unless an existing address can be reused for this deployment. */
export function checkReusableAddress(opts: DeployOptions, address: AddressState): void {
  if (address.project !== opts.project) throw new PlanError(`address ${address.name} is in project ${address.project}`);
  if (address.region !== opts.region) throw new PlanError(`address ${address.name} is in region ${address.region}`);
  if (address.tier !== opts.tier) throw new PlanError(`address ${address.name} has network tier ${address.tier}`);
  const vm = names(opts).vm;
  const foreign = address.users.filter((user) => !user.endsWith(`/instances/${vm}`));
  if (foreign.length > 0) throw new PlanError(`address ${address.name} is used by another resource`);
}

function checkOwned(base: string, what: string, resource: ResourceState): void {
  if (resource.description !== ownerMarker(base)) {
    throw new PlanError(`${what} ${resource.name} exists but is not owned by this service`);
  }
}

/** Steps that copy the build to the VM and (re)start the service. */
function installSteps(opts: DeployOptions, withKey: boolean): Step[] {
  const vm = names(opts).vm;
  const steps: Step[] = [
    { kind: "local", action: "build", detail: "esbuild bundle relay/dist/wink-relay.mjs" },
    { kind: "local", action: "fetch-node", detail: `${NODE_URL} sha256 ${NODE_SHA256}` },
    { kind: "local", action: "write-config", detail: `wink-relay.config.json base=${opts.base}` },
    g(
      [
        "compute",
        "scp",
        ...where(opts, "zone"),
        "--tunnel-through-iap",
        "@build/wink-relay.mjs",
        `@build/${NODE_TARBALL}`,
        "@build/wink-relay.config.json",
        "@deploy/wink-relay.service",
        "@deploy/wink-relay-install.sh",
        `${vm}:~/`,
      ],
      true,
      "upload bundle, Node tarball, config, unit and installer",
    ),
  ];
  if (withKey) {
    steps.push({
      ...ssh(opts, "sudo bash wink-relay-install.sh install-key", opts.operatorKeyFile),
      note: "operator key over stdin into /etc/wink-relay/operator.key (0400 root)",
    } as Step);
  }
  steps.push(ssh(opts, `sudo bash wink-relay-install.sh install ${NODE_VERSION} ${NODE_SHA256}`));
  return steps;
}

export function planProvision(opts: DeployOptions, state: ProjectState): Step[] {
  validate(opts);
  if (!opts.operatorKeyFile) throw new PlanError("provision needs --operator-key <file>");
  if (!opts.acceptAcmeTerms) throw new PlanError("provision needs --accept-acme-terms (CA subscriber agreement)");
  const n = names(opts);
  const marker = ownerMarker(opts.base);
  const steps: Step[] = [g(["services", "enable", "compute.googleapis.com", ...where(opts, "global")], true)];

  if (state.address) {
    checkReusableAddress(opts, state.address);
    steps.push(g(["compute", "addresses", "describe", n.address, ...where(opts, "region")], false, "reuse checked address"));
  } else {
    steps.push(
      g(
        ["compute", "addresses", "create", n.address, ...where(opts, "region"), "--network-tier", opts.tier, "--description", marker],
        true,
      ),
    );
  }

  const rules: Array<[string, string, string]> = [
    [n.fw443, "tcp:443", "0.0.0.0/0"],
    [n.fw22, "tcp:22", IAP_RANGE],
  ];
  for (const [name, port, source] of rules) {
    const existing = state.firewall[name];
    if (existing) {
      checkOwned(opts.base, "firewall rule", existing);
      continue;
    }
    steps.push(
      g(
        [
          "compute",
          "firewall-rules",
          "create",
          name,
          ...where(opts, "global"),
          "--network",
          "default",
          "--direction",
          "INGRESS",
          "--action",
          "ALLOW",
          "--rules",
          port,
          "--source-ranges",
          source,
          "--target-tags",
          n.tag,
          "--description",
          marker,
        ],
        true,
      ),
    );
  }

  if (state.instance) {
    checkOwned(opts.base, "instance", state.instance);
  } else {
    steps.push(
      g(
        [
          "compute",
          "instances",
          "create",
          n.vm,
          ...where(opts, "zone"),
          "--machine-type",
          opts.machine,
          "--network-tier",
          opts.tier,
          "--address",
          n.address,
          "--image-family",
          "debian-12",
          "--image-project",
          "debian-cloud",
          "--boot-disk-size",
          "10GB",
          "--boot-disk-type",
          "pd-balanced",
          "--tags",
          n.tag,
          // The relay calls no Google API, so the VM gets no identity at all.
          "--no-service-account",
          "--no-scopes",
          "--shielded-secure-boot",
          "--shielded-vtpm",
          "--shielded-integrity-monitoring",
          "--metadata",
          "enable-oslogin=TRUE,block-project-ssh-keys=TRUE",
          "--description",
          marker,
        ],
        true,
      ),
    );
  }

  steps.push(...installSteps(opts, true));
  const { host, fqdn } = dnsName(opts);
  const ip: IpRef = { addressOf: { project: opts.project, region: opts.region, name: n.address } };
  steps.push(
    { kind: "dns-upsert", zone: opts.dnsZone, host, fqdn, value: ip, ttl: DNS_TTL },
    { kind: "local", action: "wait-dns", detail: `relay.${opts.base} resolves to the reserved address` },
    // The first certificate needs DNS pointing here; restart so issuance runs now, not at the next retry.
    ssh(opts, "sudo bash wink-relay-install.sh restart"),
    { kind: "local", action: "healthz", detail: `https://relay.${opts.base}/v1/healthz` },
  );
  return steps;
}

export function planUpdate(opts: DeployOptions, state: ProjectState): Step[] {
  validate(opts);
  if (!state.instance) throw new PlanError(`instance ${names(opts).vm} not found in ${opts.project}`);
  checkOwned(opts.base, "instance", state.instance);
  return [
    ...installSteps(opts, Boolean(opts.operatorKeyFile)),
    { kind: "local", action: "healthz", detail: `https://relay.${opts.base}/v1/healthz` },
  ];
}

/**
 * Pause: DNS that points at the old IP goes first, so a released (and later
 * recycled) address never answers for <base>. Only owned resources are deleted.
 */
export function planPause(opts: DeployOptions, state: ProjectState, protect?: IpRef): Step[] {
  validate(opts);
  const n = names(opts);
  const steps: Step[] = [];
  const oldIp = state.address?.ip ?? state.instance?.ip;
  const { host, fqdn } = dnsName(opts);
  if (oldIp) steps.push({ kind: "dns-delete", zone: opts.dnsZone, host, fqdn, onlyValue: oldIp, protect });

  if (state.instance) {
    checkOwned(opts.base, "instance", state.instance);
    steps.push(g(["compute", "instances", "delete", n.vm, ...where(opts, "zone"), "--quiet"], true));
  }
  for (const name of [n.fw443, n.fw22]) {
    const rule = state.firewall[name];
    if (!rule) continue;
    checkOwned(opts.base, "firewall rule", rule);
    steps.push(g(["compute", "firewall-rules", "delete", name, ...where(opts, "global"), "--quiet"], true));
  }
  if (state.address) {
    if (state.address.description === ownerMarker(opts.base)) {
      steps.push(g(["compute", "addresses", "delete", n.address, ...where(opts, "region"), "--quiet"], true));
    } else {
      steps.push(g(["compute", "addresses", "describe", n.address, ...where(opts, "region")], false, "kept: not created by this service"));
    }
  }
  return steps;
}

/** Move: full provision in the new project, then pause the old one without touching DNS that already points at the new IP. */
export function planMove(
  opts: DeployOptions,
  fromProject: string,
  newState: ProjectState,
  oldState: ProjectState,
): Step[] {
  if (fromProject === opts.project) throw new PlanError("--from-project must differ from --project");
  const oldOpts = { ...opts, project: fromProject };
  validate(oldOpts);
  const provision = planProvision(opts, newState);
  const newIp: IpRef = { addressOf: { project: opts.project, region: opts.region, name: names(opts).address } };
  return [...provision, ...planPause(oldOpts, oldState, newIp)];
}

/** One line per step, exactly what would run. */
export function describeStep(step: Step): string {
  switch (step.kind) {
    case "gcloud":
      return [
        `gcloud ${step.args.join(" ")}`,
        step.stdinFile ? " < [operator key file]" : "",
        step.note ? `   # ${step.note}` : "",
      ].join("");
    case "dns-upsert":
      return `dns upsert A ${step.fqdn} (zone ${step.zone}, host ${step.host}) -> ${ipText(step.value)} ttl ${step.ttl}`;
    case "dns-delete":
      return `dns delete A ${step.fqdn} (zone ${step.zone}, host ${step.host}) only where value = ${step.onlyValue}${
        step.protect ? `, never ${ipText(step.protect)}` : ""
      }`;
    case "local":
      return `local ${step.action}: ${step.detail}`;
  }
}

export function ipText(ref: IpRef): string {
  return "ip" in ref ? ref.ip : `[address ${ref.addressOf.name} in ${ref.addressOf.project}/${ref.addressOf.region}]`;
}
