// node relay/deploy/cli.ts <provision|update|move|pause> --project P --base B --dns-zone Z [options]
//
// Dry run by default: discovers state read-only and prints the plan.
// Mutations happen only with --apply. Secrets come from files or env, never argv.

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { discover, execute, gcloudRunner, manualDns, nameComDns, realLocal, type DnsAccess } from "./exec.ts";
import {
  PlanError,
  describeStep,
  ownerMarker,
  planMove,
  planPause,
  planProvision,
  planUpdate,
  type DeployOptions,
  type DnsMode,
  type ProjectState,
  type Step,
  type Tier,
} from "./plan.ts";

const USAGE = `usage: wink-relay <provision|update|move|pause> --project P --base B --dns-zone Z
  [--region asia-northeast3] [--zone <region>-a] [--network-tier STANDARD|PREMIUM]
  [--machine e2-small] [--prefix wink-relay] [--address-name <prefix>-ip] [--operator-key FILE]
  [--dns namecom|manual]
  [--acme-directory URL] [--acme-email E] [--accept-acme-terms]
  [--from-project OLD]   (move)
  [--offline]            (provision/update: plan without reading cloud state)
  [--apply]              (without it, nothing is changed)
env: NAMECOM_USER, NAMECOM_TOKEN for --dns namecom (manual needs none).`;

/** Offline planning: nothing exists yet, except the instance an update targets. */
function offlineState(action: string, base: string): ProjectState {
  const instance = action === "update" ? { name: "", description: ownerMarker(base) } : null;
  return { address: null, firewall: {}, instance, dns: [] };
}

export function parseOptions(argv: string[]): { action: string; opts: DeployOptions; fromProject?: string; apply: boolean; offline: boolean } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      "from-project": { type: "string" },
      base: { type: "string" },
      "dns-zone": { type: "string" },
      region: { type: "string", default: "asia-northeast3" },
      zone: { type: "string" },
      "network-tier": { type: "string", default: "STANDARD" },
      machine: { type: "string", default: "e2-small" },
      prefix: { type: "string", default: "wink-relay" },
      "address-name": { type: "string" },
      dns: { type: "string", default: "namecom" },
      "operator-key": { type: "string" },
      "acme-directory": { type: "string", default: "https://acme-v02.api.letsencrypt.org/directory" },
      "acme-email": { type: "string" },
      "accept-acme-terms": { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
    },
  });
  const action = positionals[0] === "teardown" ? "pause" : (positionals[0] ?? "");
  if (!["provision", "update", "move", "pause"].includes(action)) throw new PlanError(USAGE);
  if (!values.project || !values.base || !values["dns-zone"]) throw new PlanError(USAGE);
  const region = values.region!;
  const opts: DeployOptions = {
    project: values.project,
    region,
    zone: values.zone ?? `${region}-a`,
    tier: values["network-tier"]!.toUpperCase() as Tier,
    base: values.base.toLowerCase(),
    dnsZone: values["dns-zone"].toLowerCase(),
    prefix: values.prefix!,
    addressName: values["address-name"] ?? `${values.prefix!}-ip`,
    dnsMode: values.dns!.toLowerCase() as DnsMode,
    machine: values.machine!,
    operatorKeyFile: values["operator-key"],
    acmeDirectory: values["acme-directory"]!,
    acmeEmail: values["acme-email"],
    acceptAcmeTerms: values["accept-acme-terms"]!,
  };
  if (action === "move" && !values["from-project"]) throw new PlanError("move needs --from-project");
  if (values.offline && (action === "move" || action === "pause")) {
    throw new PlanError(`${action} must read current state; --offline is for provision and update`);
  }
  return { action, opts, fromProject: values["from-project"], apply: values.apply!, offline: values.offline! };
}

export async function plan(
  action: string,
  opts: DeployOptions,
  fromProject: string | undefined,
  read: (project: string) => Promise<ProjectState>,
): Promise<Step[]> {
  switch (action) {
    case "provision":
      return planProvision(opts, await read(opts.project));
    case "update":
      return planUpdate(opts, await read(opts.project));
    case "pause":
      return planPause(opts, await read(opts.project));
    default:
      return planMove(opts, fromProject!, await read(opts.project), await read(fromProject!));
  }
}

async function main(): Promise<void> {
  const { action, opts, fromProject, apply, offline } = parseOptions(process.argv.slice(2));
  const out = (line: string) => process.stdout.write(`${line}\n`);
  // Planning needs no registrar access (deletes re-read records at apply time); applying does.
  // Manual DNS never touches a registrar and reads public DNS only.
  const hasDnsCreds = Boolean(process.env.NAMECOM_USER && process.env.NAMECOM_TOKEN);
  let dns: DnsAccess | null = null;
  if (opts.dnsMode === "manual") dns = manualDns(opts);
  else if (apply || hasDnsCreds) dns = nameComDns();
  const read = (project: string): Promise<ProjectState> =>
    offline ? Promise.resolve(offlineState(action, opts.base)) : discover({ ...opts, project }, gcloudRunner, dns);
  const steps = await plan(action, opts, fromProject, read);

  out(
    `PLAN ${action}: project=${opts.project}${fromProject ? ` from=${fromProject}` : ""} region=${opts.region} zone=${opts.zone} tier=${opts.tier} base=${opts.base} address=${opts.addressName} dns=${opts.dnsMode}`,
  );
  steps.forEach((step, i) => out(`${String(i + 1).padStart(2)}. ${describeStep(step)}`));
  if (!apply) {
    out(offline ? "dry run (offline: state assumed empty), nothing changed" : "dry run, nothing changed. Re-run with --apply to execute.");
    return;
  }
  const relayDir = fileURLToPath(new URL("..", import.meta.url));
  const buildDir = fileURLToPath(new URL("../dist/deploy", import.meta.url));
  const deployDir = fileURLToPath(new URL(".", import.meta.url));
  await execute(steps, opts, {
    runner: gcloudRunner,
    dns: dns!,
    local: realLocal(relayDir, buildDir),
    buildDir,
    deployDir,
    out,
  });
  out("done");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`wink-relay deploy: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  });
}
