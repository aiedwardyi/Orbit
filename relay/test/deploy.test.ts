import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { getCACertificates, setDefaultCACertificates, type TLSSocket } from "node:tls";
import { describe, expect, it } from "vitest";
import { parseOptions, plan } from "../deploy/cli.ts";
import {
  discover,
  execute,
  manualDns,
  probeAt,
  realLocal,
  type Dns,
  type DnsAccess,
  type Local,
  type Resolve4,
  type Runner,
} from "../deploy/exec.ts";
import {
  PlanError,
  describeStep,
  ownerMarker,
  planMove,
  planPause,
  planProvision,
  type DeployOptions,
  type DnsRecord,
  type ProjectState,
  type Step,
} from "../deploy/plan.ts";
import { makeCa } from "./fixtures.ts";

const BASE = "wink.example.com";
const opts = (over: Partial<DeployOptions> = {}): DeployOptions => ({
  project: "wink-new-proj",
  region: "asia-northeast3",
  zone: "asia-northeast3-a",
  tier: "STANDARD",
  base: BASE,
  dnsZone: "example.com",
  prefix: "wink-relay",
  machine: "e2-small",
  operatorKeyFile: "/keys/operator.key",
  acmeDirectory: "https://acme-staging-v02.api.letsencrypt.org/directory",
  acceptAcmeTerms: true,
  ...over,
});
const EMPTY: ProjectState = { address: null, firewall: {}, instance: null, dns: [] };
const owned = { description: ownerMarker(BASE) };

function deployedState(project: string, ip: string): ProjectState {
  return {
    address: {
      name: "wink-relay-ip",
      project,
      region: "asia-northeast3",
      tier: "STANDARD",
      ip,
      status: "IN_USE",
      users: [`https://www.googleapis.com/compute/v1/projects/${project}/zones/asia-northeast3-a/instances/wink-relay-vm`],
      description: ownerMarker(BASE),
    },
    firewall: {
      "wink-relay-allow-443": { name: "wink-relay-allow-443", ...owned },
      "wink-relay-allow-iap-22": { name: "wink-relay-allow-iap-22", ...owned },
      "wink-relay-deny-admin": { name: "wink-relay-deny-admin", ...owned },
    },
    instance: { name: "wink-relay-vm", ...owned, ip },
    dns: [],
  };
}

const lines = (steps: Step[]) => steps.map(describeStep);
const indexOf = (steps: Step[], pattern: RegExp) => lines(steps).findIndex((l) => pattern.test(l));

describe("provision plan", () => {
  it("targets exactly the named resources in Seoul on the Standard tier, least privilege", () => {
    const steps = planProvision(opts(), EMPTY);
    const text = lines(steps);
    expect(text).toContain(
      "gcloud compute addresses create wink-relay-ip --project wink-new-proj --region asia-northeast3 --network-tier STANDARD --description wink-relay-owned:wink.example.com   # owned; pause and move release only addresses that carry this marker",
    );
    const vm = text.find((l) => l.startsWith("gcloud compute instances create"))!;
    expect(vm).toContain("wink-relay-vm --project wink-new-proj --zone asia-northeast3-a --machine-type e2-small --network-tier STANDARD --address wink-relay-ip");
    expect(vm).toContain("--no-service-account --no-scopes");
    expect(vm).toContain("block-project-ssh-keys=TRUE");
    expect(text.find((l) => l.includes("allow-iap-22"))).toContain("--rules tcp:22 --source-ranges 35.235.240.0/20 --priority 1000");
    expect(text.find((l) => l.includes("allow-443"))).toContain("--rules tcp:443 --source-ranges 0.0.0.0/0");
    expect(text.filter((l) => l.startsWith("gcloud") && / delete /.test(l))).toEqual([]);
    // The key path is a placeholder until apply time and is never printed.
    expect(text.join("\n")).not.toContain("/keys/operator.key");
    // DNS goes up after the VM, then wait, restart for the first certificate, health.
    expect(indexOf(steps, /^dns upsert A \*\.wink\.example\.com \(zone example\.com, host \*\.wink\)/)).toBeGreaterThan(
      indexOf(steps, /instances create/),
    );
    expect(text.slice(-3)).toEqual([
      "local wait-dns: relay.wink.example.com resolves to the reserved address",
      "gcloud compute ssh wink-relay-vm --project wink-new-proj --zone asia-northeast3-a --tunnel-through-iap --command sudo bash wink-relay-install.sh restart",
      "local healthz: https://relay.wink.example.com/v1/healthz",
    ]);
  });

  it("verifies the Node artifact by pinned sha256 locally and on the VM", () => {
    const text = lines(planProvision(opts(), EMPTY)).join("\n");
    expect(text).toContain("node-v24.21.0-linux-x64.tar.xz sha256 fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6");
    expect(text).toContain("wink-relay-install.sh install 24.21.0 fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6");
  });

  it("reuses a static address only when project, region and tier match", () => {
    const good = deployedState("wink-new-proj", "34.64.0.10");
    const steps = planProvision(opts(), { ...EMPTY, address: { ...good.address!, users: [], status: "RESERVED" } });
    expect(lines(steps).some((l) => l.includes("addresses create"))).toBe(false);
    expect(lines(steps)).toContain(
      "gcloud compute addresses describe wink-relay-ip --project wink-new-proj --region asia-northeast3   # reuse checked address",
    );
    for (const bad of [{ tier: "PREMIUM" }, { region: "asia-northeast1" }, { project: "someone-else" }, { users: ["projects/x/instances/other-vm"] }]) {
      expect(() => planProvision(opts(), { ...EMPTY, address: { ...good.address!, ...bad } })).toThrow(PlanError);
    }
  });

  it("refuses to adopt same-named resources it does not own", () => {
    expect(() => planProvision(opts(), { ...EMPTY, instance: { name: "wink-relay-vm", description: "" } })).toThrow(/not owned/);
    expect(() =>
      planProvision(opts(), { ...EMPTY, firewall: { "wink-relay-allow-443": { name: "wink-relay-allow-443", description: "x" } } }),
    ).toThrow(/not owned/);
  });

  it("validates arguments and needs explicit key and ACME terms", () => {
    expect(() => planProvision(opts({ operatorKeyFile: undefined }), EMPTY)).toThrow(/operator-key/);
    expect(() => planProvision(opts({ acceptAcmeTerms: false }), EMPTY)).toThrow(/accept-acme-terms/);
    expect(() => planProvision(opts({ base: "wink.other.org" }), EMPTY)).toThrow(/dns-zone/);
    expect(() => planProvision(opts({ project: "Bad Project" }), EMPTY)).toThrow(/project/);
    expect(() => planProvision(opts({ zone: "us-central1-a" }), EMPTY)).toThrow(/zone/);
  });
});

describe("Windows and default-project hardening", () => {
  it("scp targets the login home as '.', which pscp (SFTP, no ~ expansion) accepts", () => {
    const text = lines(planProvision(opts(), EMPTY));
    const scps = text.filter((l) => l.startsWith("gcloud compute scp"));
    expect(scps.length).toBe(2);
    expect(scps[0]).toMatch(/@deploy\/wink-relay-install\.sh wink-relay-vm:\.   #/);
    expect(text.join("\n")).not.toMatch(/wink-relay-vm:~/);
  });

  it("installs the operator key from an uploaded file, not stdin, and keeps the path out of the plan", async () => {
    const steps = planProvision(opts(), EMPTY);
    const text = lines(steps);
    const upload = indexOf(steps, /^gcloud compute scp .* \[operator key file\] wink-relay-vm:operator\.key\.upload/);
    const install = indexOf(steps, /--command sudo bash wink-relay-install\.sh install-key operator\.key\.upload/);
    expect(upload).toBeGreaterThan(0);
    expect(install).toBe(upload + 1);
    expect(text[install]).toContain("/etc/wink-relay/operator.key (0400 root), shred ~/operator.key.upload");
    expect(indexOf(steps, /install-key/)).toBeLessThan(indexOf(steps, /install 24\.21\.0/));
    expect(text.join("\n")).not.toContain("/keys/operator.key");
    // At apply time the placeholder becomes the file path, as an scp source only.
    const fx = fakes({});
    await execute(steps.slice(upload, upload + 1), opts(), fx.ctx);
    expect(fx.calls[0]).toMatch(/--tunnel-through-iap \/keys\/operator\.key wink-relay-vm:operator\.key\.upload$/);
    // The installer reads the upload from the deploying user's home and shreds it on every exit path.
    const script = readFileSync(new URL("../deploy/wink-relay-install.sh", import.meta.url), "utf8");
    const keyBranch = script.slice(script.indexOf("install-key)"), script.indexOf("install)"));
    expect(keyBranch).toContain('upload="$home/$name"');
    expect(keyBranch.indexOf("shred -u")).toBeLessThan(keyBranch.indexOf("BEGIN PRIVATE KEY"));
    expect(keyBranch).toMatch(/trap .*shred -u "\$upload".* EXIT/);
    expect(keyBranch).toContain("chmod 0400");
    expect(keyBranch).not.toMatch(/head -c 4096 >/);
  });

  it("creates the VM with guest attributes on so host keys are published at first boot", () => {
    const vm = lines(planProvision(opts(), EMPTY)).find((l) => l.startsWith("gcloud compute instances create"))!;
    expect(vm).toContain("--metadata enable-oslogin=TRUE,block-project-ssh-keys=TRUE,enable-guest-attributes=TRUE");
  });

  it("enables the IAP API next to compute", () => {
    expect(lines(planProvision(opts(), EMPTY))[0]).toBe(
      "gcloud services enable compute.googleapis.com iap.googleapis.com --project wink-new-proj",
    );
  });

  it("adds an owned deny for 22 and 3389 above the default rules, below the IAP allow, and deletes it on pause", () => {
    const text = lines(planProvision(opts(), EMPTY));
    expect(text).toContain(
      "gcloud compute firewall-rules create wink-relay-deny-admin --project wink-new-proj --network default --direction INGRESS --action DENY --rules tcp:22,tcp:3389 --source-ranges 0.0.0.0/0 --priority 1100 --target-tags wink-relay --description wink-relay-owned:wink.example.com",
    );
    // Rules it does not own are never deleted.
    expect(text.join("\n")).not.toMatch(/default-allow/);
    expect(lines(planPause(opts(), deployedState("wink-new-proj", "34.64.0.10")))).toContain(
      "gcloud compute firewall-rules delete wink-relay-deny-admin --project wink-new-proj --quiet",
    );
    const state = deployedState("wink-new-proj", "34.64.0.10");
    expect(() =>
      planProvision(opts(), {
        ...state,
        firewall: { ...state.firewall, "wink-relay-deny-admin": { name: "wink-relay-deny-admin", description: "" } },
      }),
    ).toThrow(/not owned/);
  });

  it("reuses an existing address by name and never releases it unless it carries the owner marker", async () => {
    const o = opts({ addressName: "wink-relay" });
    const state = deployedState("wink-new-proj", "34.64.0.10");
    const live = { ...state, address: { ...state.address!, name: "wink-relay", description: "" } };
    const text = lines(planProvision(o, { ...EMPTY, address: { ...live.address, users: [], status: "RESERVED" } }));
    expect(text.some((l) => l.includes("addresses create"))).toBe(false);
    expect(text).toContain(
      "gcloud compute addresses describe wink-relay --project wink-new-proj --region asia-northeast3   # reuse checked address; not created by this service, so pause and move never release it",
    );
    expect(text.find((l) => l.startsWith("gcloud compute instances create"))).toContain("--address wink-relay ");
    // The reuse checks still apply to a named address.
    expect(() => planProvision(o, { ...EMPTY, address: { ...live.address, users: ["projects/x/instances/other-vm"] } })).toThrow(
      /used by another/,
    );
    const pause = lines(planPause(o, live));
    expect(pause.some((l) => l.includes("addresses delete"))).toBe(false);
    expect(pause.at(-1)).toBe(
      "gcloud compute addresses describe wink-relay --project wink-new-proj --region asia-northeast3   # kept: not created by this service, never released",
    );
    // Discovery describes the named address.
    const fx = fakes({ "wink-new-proj": live });
    await discover(o, fx.ctx.runner, null);
    expect(fx.calls[0]).toBe("compute addresses describe wink-relay --project wink-new-proj --region asia-northeast3 --format=json");
    expect(parseOptions(["pause", "--project", "wink-new-proj", "--base", BASE, "--dns-zone", "example.com"]).opts.addressName).toBe(
      "wink-relay-ip",
    );
  });
});

describe("manual DNS", () => {
  const manual = opts({ dnsMode: "manual" });
  const resolverAt = (answers: Record<string, string[]>) => {
    const asked: string[] = [];
    const resolve4: Resolve4 = async (server, fqdn) => {
      asked.push(`${server} ${fqdn}`);
      return answers[server] ?? [];
    };
    return { asked, resolve4 };
  };

  it("plans a check instead of an upsert and parses --dns manual", () => {
    const text = lines(planProvision(manual, EMPTY));
    expect(text.find((l) => l.startsWith("dns "))).toBe(
      "dns check (manual) A *.wink.example.com -> [address wink-relay-ip in wink-new-proj/asia-northeast3]: a random name under it must resolve via 8.8.8.8 and 1.1.1.1, else stop with the record to add: A *.wink -> [ip], TTL 300 (zone example.com)",
    );
    const parsed = parseOptions(["provision", "--project", "wink-new-proj", "--base", BASE, "--dns-zone", "example.com", "--dns", "manual"]);
    expect(parsed.opts.dnsMode).toBe("manual");
    expect(() =>
      parseOptions(["provision", "--project", "wink-new-proj", "--base", BASE, "--dns-zone", "example.com", "--dns", "cloudflare"]),
    ).toThrow(/--dns is namecom or manual/);
  });

  it("upsert passes only when a random name under base resolves to the address, else fails with the exact record", async () => {
    const fx = fakes({ "wink-new-proj": deployedState("wink-new-proj", "34.64.0.10") });
    const upsert = planProvision(manual, fx.state["wink-new-proj"]).filter((s) => s.kind === "dns-upsert");
    const good = resolverAt({ "8.8.8.8": ["34.64.0.10"], "1.1.1.1": ["34.64.0.10"] });
    await execute(upsert, manual, { ...fx.ctx, dns: manualDns(manual, good.resolve4) });
    expect(good.asked.map((a) => a.split(" ")[0])).toEqual(["8.8.8.8", "1.1.1.1"]);
    expect(good.asked[0]).toMatch(/^8\.8\.8\.8 probe-[0-9a-f]{12}\.wink\.example\.com$/);
    const stale = resolverAt({ "8.8.8.8": ["34.64.0.99"] });
    await expect(execute(upsert, manual, { ...fx.ctx, dns: manualDns(manual, stale.resolve4) })).rejects.toThrow(
      "Add this record in zone example.com, then re-run: A *.wink -> 34.64.0.10, TTL 300",
    );
    await expect(execute(upsert, manual, { ...fx.ctx, dns: manualDns(manual, resolverAt({}).resolve4) })).rejects.toThrow(
      /resolves to nothing, not 34\.64\.0\.10/,
    );
  });

  it("refuses manual DNS release without a complete record inventory", async () => {
    const fx = fakes({ "wink-new-proj": deployedState("wink-new-proj", "34.64.0.10") });
    const r = resolverAt({ "8.8.8.8": ["34.64.0.10"], "1.1.1.1": ["34.64.0.10"] });
    const dns = manualDns(manual, r.resolve4);
    const discovered = await discover(manual, fx.ctx.runner, dns);
    expect(discovered.dns).toEqual([{ id: 0, host: "*.wink", type: "A", answer: "34.64.0.10" }]);
    const steps = planPause(manual, discovered);
    expect(lines(steps)[0]).toBe("dns delete (manual) print the record to remove by hand: A *.wink -> 34.64.0.10 (zone example.com)");
    const out: string[] = [];
    await expect(execute(steps, manual, { ...fx.ctx, dns, out: (l) => out.push(l) })).rejects.toThrow(/manual DNS cannot verify/);
    expect(fx.calls.some((c) => c.includes(" delete "))).toBe(false);
    expect(fx.dnsOps).toEqual([]);
  });
});

describe("pause plan", () => {
  it("removes DNS pointing at the old IP before deleting the VM and releasing the IP", () => {
    const steps = planPause(opts(), deployedState("wink-new-proj", "34.64.0.10"));
    const text = lines(steps);
    expect(text).toEqual([
      "dns delete A *.wink.example.com (zone example.com, host *.wink) only where value = 34.64.0.10",
      "gcloud compute instances delete wink-relay-vm --project wink-new-proj --zone asia-northeast3-a --quiet",
      "gcloud compute firewall-rules delete wink-relay-allow-443 --project wink-new-proj --quiet",
      "gcloud compute firewall-rules delete wink-relay-allow-iap-22 --project wink-new-proj --quiet",
      "gcloud compute firewall-rules delete wink-relay-deny-admin --project wink-new-proj --quiet",
      "gcloud compute addresses delete wink-relay-ip --project wink-new-proj --region asia-northeast3 --quiet",
    ]);
  });

  it("keeps an address it did not create and refuses foreign instances", () => {
    const state = deployedState("wink-new-proj", "34.64.0.10");
    const text = lines(planPause(opts(), { ...state, address: { ...state.address!, description: "" } }));
    expect(text.some((l) => l.includes("addresses delete"))).toBe(false);
    expect(text.at(-1)).toContain("kept: not created by this service");
    expect(() => planPause(opts(), { ...state, instance: { name: "wink-relay-vm", description: "" } })).toThrow(/not owned/);
  });
});

describe("move plan", () => {
  it("provisions the new project, switches DNS, then tears down the old one without touching the new record", () => {
    const steps = planMove(opts(), "wink-old-proj", EMPTY, deployedState("wink-old-proj", "34.64.0.20"));
    const upsert = indexOf(steps, /^dns upsert .* \[address wink-relay-ip in wink-new-proj\/asia-northeast3\]/);
    const health = indexOf(steps, /^local healthz/);
    const dnsDelete = indexOf(steps, /^dns delete .* only where value = 34\.64\.0\.20, never \[address wink-relay-ip in wink-new-proj/);
    const release = indexOf(steps, /addresses delete wink-relay-ip --project wink-old-proj/);
    expect(upsert).toBeGreaterThan(0);
    expect(health).toBeGreaterThan(upsert);
    expect(dnsDelete).toBeGreaterThan(health);
    expect(release).toBeGreaterThan(dnsDelete);
    // Nothing in the new project is deleted.
    expect(lines(steps).filter((l) => l.startsWith("gcloud") && / delete /.test(l) && l.includes("wink-new-proj"))).toEqual([]);
    expect(() => planMove(opts(), "wink-new-proj", EMPTY, EMPTY)).toThrow(/differ/);
  });

  it("at apply time deletes only records still on the old IP and never the new one", async () => {
    const fx = fakes({
      "wink-new-proj": deployedState("wink-new-proj", "34.64.0.30"),
      "wink-old-proj": deployedState("wink-old-proj", "34.64.0.20"),
    });
    // Before the move, the wildcard points at the old relay.
    fx.records.push({ id: 1, host: "*.wink", type: "A", answer: "34.64.0.20" }, { id: 2, host: "www", type: "A", answer: "34.64.0.20" });
    const steps = planMove(opts(), "wink-old-proj", EMPTY, fx.state["wink-old-proj"]);
    await execute(steps, opts(), fx.ctx);
    // The upsert moved record 1 to the new IP, so the old-IP delete found nothing of ours to remove.
    expect(fx.records).toEqual([
      { id: 1, host: "*.wink", type: "A", answer: "34.64.0.30" },
      { id: 2, host: "www", type: "A", answer: "34.64.0.20" },
    ]);
    expect(fx.dnsOps).toEqual(["update 1 *.wink 34.64.0.30"]);
    // DNS changed before any old-project delete ran.
    const firstOldDelete = fx.calls.findIndex((c) => c.includes(" delete ") && c.includes("wink-old-proj"));
    expect(fx.order.indexOf("dns:update")).toBeLessThan(fx.order.indexOf(`gcloud:${firstOldDelete}`));
  });

  it("probes health at the new reserved address, so a cached old IP cannot pass for it", async () => {
    const fx = fakes({
      "wink-new-proj": deployedState("wink-new-proj", "34.64.0.30"),
      "wink-old-proj": deployedState("wink-old-proj", "34.64.0.20"),
    });
    const probes: string[] = [];
    const local: Local = { ...fx.ctx.local, healthz: async (url, ip) => void probes.push(`${url} ${ip}`) };
    await execute(planMove(opts(), "wink-old-proj", EMPTY, fx.state["wink-old-proj"]), opts(), { ...fx.ctx, local });
    expect(probes).toEqual(["https://relay.wink.example.com/v1/healthz 34.64.0.30"]);
  });
});

describe("health probe", () => {
  it("connects to the given IP with SNI, Host and certificate checks for the URL's host", async () => {
    const ca = await makeCa();
    const seen: string[] = [];
    const server = createServer(await ca.issue(`relay.${BASE}`), (req, res) => {
      // SAFETY: an https server's requests arrive on TLS sockets.
      seen.push(`${(req.socket as TLSSocket).servername} ${req.headers.host} ${req.method} ${req.url}`);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: the server listens on TCP, so address() is an AddressInfo, not a pipe name or null.
    const { port } = server.address() as AddressInfo;
    // relay.<base> does not resolve, so only the given IP can reach this server.
    const url = `https://relay.${BASE}:${port}/v1/healthz`;
    const defaults = getCACertificates("default");
    try {
      expect(await probeAt(url, "127.0.0.1")).toBe(false);
      setDefaultCACertificates([ca.certPem]);
      await realLocal("/r", "/b").healthz(url, "127.0.0.1");
    } finally {
      setDefaultCACertificates(defaults);
      server.close();
    }
    expect(seen).toEqual([`relay.${BASE} relay.${BASE}:${port} GET /v1/healthz`]);
  });
});

describe("dry run and discovery", () => {
  it("discovery only reads, and a dry run makes no mutating call", async () => {
    const fx = fakes({ "wink-new-proj": deployedState("wink-new-proj", "34.64.0.10") });
    const read = (project: string) => discover({ ...opts(), project }, fx.ctx.runner, fx.ctx.dns);
    const steps = await plan("pause", opts(), undefined, read);
    expect(fx.calls.every((c) => / describe /.test(c))).toBe(true);
    expect(fx.dnsOps).toEqual([]);
    expect(lines(steps)[0]).toBe("dns delete A *.wink.example.com (zone example.com, host *.wink) only where value = 34.64.0.10");
  });

  it("pause at apply time deletes the old record before the IP release", async () => {
    const fx = fakes({ "wink-new-proj": deployedState("wink-new-proj", "34.64.0.10") });
    fx.records.push({ id: 7, host: "*.wink", type: "A", answer: "34.64.0.10" });
    await execute(planPause(opts(), fx.state["wink-new-proj"]), opts(), fx.ctx);
    expect(fx.records).toEqual([]);
    const release = fx.calls.findIndex((c) => c.includes("addresses delete"));
    expect(fx.order.indexOf("dns:remove")).toBeLessThan(fx.order.indexOf(`gcloud:${release}`));
  });

  it("parses CLI options with Seoul and Standard as defaults and dry run unless --apply", () => {
    const parsed = parseOptions(["provision", "--project", "wink-new-proj", "--base", "Wink.Example.com", "--dns-zone", "example.com"]);
    expect(parsed.apply).toBe(false);
    expect(parsed.opts).toMatchObject({ region: "asia-northeast3", zone: "asia-northeast3-a", tier: "STANDARD", base: BASE });
    expect(() => parseOptions(["pause", "--project", "p", "--base", BASE, "--dns-zone", "example.com", "--offline"])).toThrow(/offline/);
    expect(() => parseOptions(["move", "--project", "wink-new-proj", "--base", BASE, "--dns-zone", "example.com"])).toThrow(/from-project/);
  });
});

/** In-memory gcloud and DNS. Records every call; never reaches a provider. */
function fakes(state: Record<string, ProjectState>) {
  const calls: string[] = [];
  const order: string[] = [];
  const dnsOps: string[] = [];
  const records: DnsRecord[] = [];
  let nextId = 100;
  const runner: Runner = {
    async gcloud(args) {
      const line = args.join(" ");
      order.push(`gcloud:${calls.length}`);
      calls.push(line);
      const project = args[args.indexOf("--project") + 1];
      const s = state[project] ?? EMPTY;
      if (args[2] === "describe") {
        const name = args[3];
        const notFound = { code: 1, stdout: "", stderr: `ERROR: The resource '${name}' was not found` };
        if (args[1] === "addresses") {
          const a = s.address;
          if (!a) return notFound;
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              address: a.ip,
              networkTier: a.tier,
              region: `https://www.googleapis.com/compute/v1/projects/${a.project}/regions/${a.region}`,
              selfLink: `https://www.googleapis.com/compute/v1/projects/${a.project}/regions/${a.region}/addresses/${a.name}`,
              status: a.status,
              users: a.users,
              description: a.description,
            }),
          };
        }
        if (args[1] === "firewall-rules") {
          const f = s.firewall[name];
          return f ? { code: 0, stderr: "", stdout: JSON.stringify({ description: f.description }) } : notFound;
        }
        const i = s.instance;
        return i
          ? {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({ description: i.description, networkInterfaces: [{ accessConfigs: [{ natIP: i.ip }] }] }),
            }
          : notFound;
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const dns: Dns = {
    kind: "namecom",
    async list() {
      return records.map((r) => ({ ...r }));
    },
    async create(_zone, host, ip) {
      order.push("dns:create");
      dnsOps.push(`create ${host} ${ip}`);
      records.push({ id: nextId++, host, type: "A", answer: ip });
    },
    async update(_zone, id, host, ip) {
      order.push("dns:update");
      dnsOps.push(`update ${id} ${host} ${ip}`);
      const r = records.find((x) => x.id === id)!;
      r.answer = ip;
    },
    async remove(_zone, id) {
      order.push("dns:remove");
      dnsOps.push(`remove ${id}`);
      records.splice(
        records.findIndex((x) => x.id === id),
        1,
      );
    },
  };
  const local: Local = {
    build: async () => {},
    fetchNode: async () => {},
    writeConfig: async () => {},
    waitDns: async () => {},
    healthz: async () => {},
  };
  const dnsAccess: DnsAccess = dns;
  return {
    state,
    calls,
    order,
    dnsOps,
    records,
    ctx: { runner, dns: dnsAccess, local, buildDir: "/b", deployDir: "/d", out: (_line: string) => {} },
  };
}
