import { expect, it } from "vitest";
import { parseOptions } from "../deploy/cli.ts";
import { execute, type Dns, type Local, type Runner } from "../deploy/exec.ts";
import { isRelayDnsHost, ownerMarker, planPause, type DeployOptions, type DnsRecord, type ProjectState } from "../deploy/plan.ts";

const opts: DeployOptions = {
  project: "wink-test-proj",
  region: "asia-northeast3",
  zone: "asia-northeast3-a",
  tier: "STANDARD",
  base: "wink.example.com",
  dnsZone: "example.com",
  prefix: "wink-relay",
  machine: "e2-small",
  acmeDirectory: "https://ca.invalid/directory",
  acceptAcmeTerms: true,
};

it.each(["remove", "retain", "protect"])("checks relay/PC DNS before IP release: %s", async (mode) => {
  const ip = "192.0.2.10";
  const records: DnsRecord[] = [
    { id: 1, host: "*.wink", type: "A", answer: ip },
    { id: 2, host: "relay.wink", type: "A", answer: ip },
    { id: 3, host: "www", type: "A", answer: ip },
    { id: 4, host: "abcdefghijklmnop.wink", type: "A", answer: ip },
    { id: 5, host: "www.wink", type: "A", answer: ip },
    { id: 6, host: "relay.wink", type: "A", answer: "192.0.2.20" },
  ];
  const state: ProjectState = {
    address: {
      name: "wink-relay-ip", project: opts.project, region: opts.region, tier: opts.tier,
      ip, status: "RESERVED", users: [], description: ownerMarker(opts.base),
    },
    firewall: {},
    instance: null,
    dns: [],
  };
  let danglingAtRelease: DnsRecord[] | undefined;
  const runner: Runner = {
    async gcloud(args) {
      if (args.slice(0, 3).join(" ") === "compute addresses delete") {
        danglingAtRelease = records.filter((record) => isRelayDnsHost(record.host, "*.wink") && record.answer === ip);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const dns: Dns = {
    kind: "namecom",
    async list() { return records.map((record) => ({ ...record })); },
    async create() { throw new Error("unexpected DNS create"); },
    async update() { throw new Error("unexpected DNS update"); },
    async remove(_zone, id) {
      if (mode !== "retain") records.splice(records.findIndex((record) => record.id === id), 1);
    },
  };
  const unexpected = async () => { throw new Error("unexpected local step"); };
  const local: Local = { build: unexpected, fetchNode: unexpected, writeConfig: unexpected, waitDns: unexpected, healthz: unexpected };
  const protect = mode === "protect" ? { ip } : { ip: "192.0.2.20" };
  const run = execute(planPause(opts, state, protect), opts, { runner, dns, local, buildDir: "/b", deployDir: "/d", out: () => {} });
  if (mode === "retain") {
    await expect(run).rejects.toThrow(/refusing release/);
    expect(danglingAtRelease).toBeUndefined();
  } else {
    await run;
    expect(danglingAtRelease).toHaveLength(mode === "protect" ? 3 : 0);
  }
  expect(records.filter((record) => [3, 5, 6].includes(record.id))).toHaveLength(3);
});

it.each([
  ["relay", "*", true],
  ["abcdefghijklmnop", "*", true],
  ["RELAY.wink", "*.wink", true],
  ["relay.deep.wink", "*.deep.wink", true],
  ["relay.other", "*.wink", false],
  ["www.wink", "*.wink", false],
  ["x.relay.wink", "*.wink", false],
])("matches only relay DNS hosts: %s under %s", (host, wildcard, expected) => {
  expect(isRelayDnsHost(host, wildcard)).toBe(expected);
});

it("rejects an offline apply that bypasses update ownership discovery", () => {
  expect(() => parseOptions([
    "update", "--project", opts.project, "--base", opts.base, "--dns-zone", opts.dnsZone, "--offline", "--apply",
  ])).toThrow(/--offline.*--apply/);
});
