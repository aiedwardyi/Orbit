import { expect, it } from "vitest";
import { parseOptions } from "../deploy/cli.ts";
import { execute, type Dns, type Local, type Runner } from "../deploy/exec.ts";
import { ownerMarker, planPause, type DeployOptions, type DnsRecord, type ProjectState } from "../deploy/plan.ts";

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

it("releases an address while an explicit relay A record still points at it", async () => {
  const ip = "192.0.2.10";
  const records: DnsRecord[] = [
    { id: 1, host: "*.wink", type: "A", answer: ip },
    { id: 2, host: "relay.wink", type: "A", answer: ip },
    { id: 3, host: "www", type: "A", answer: ip },
  ];
  const state: ProjectState = {
    address: {
      name: "wink-relay-ip", project: opts.project, region: opts.region, tier: opts.tier,
      ip, status: "RESERVED", users: [], description: ownerMarker(opts.base),
    },
    firewall: {},
    instance: null,
    dns: records,
  };
  let danglingAtRelease: DnsRecord[] | undefined;
  const runner: Runner = {
    async gcloud(args) {
      if (args.slice(0, 3).join(" ") === "compute addresses delete") {
        danglingAtRelease = records.filter((record) => record.host.endsWith(".wink") && record.answer === ip);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const dns: Dns = {
    async list() { return records.map((record) => ({ ...record })); },
    async create() { throw new Error("unexpected DNS create"); },
    async update() { throw new Error("unexpected DNS update"); },
    async remove(_zone, id) { records.splice(records.findIndex((record) => record.id === id), 1); },
  };
  const unexpected = async () => { throw new Error("unexpected local step"); };
  const local: Local = { build: unexpected, fetchNode: unexpected, writeConfig: unexpected, waitDns: unexpected, healthz: unexpected };
  await execute(planPause(opts, state), opts, { runner, dns, local, buildDir: "/b", deployDir: "/d", out: () => {} });
  expect(records.some((record) => record.host === "www")).toBe(true);
  expect(danglingAtRelease).toEqual([{ id: 2, host: "relay.wink", type: "A", answer: ip }]);
});

it("accepts an offline apply that bypasses update ownership discovery", () => {
  expect(parseOptions([
    "update", "--project", opts.project, "--base", opts.base, "--dns-zone", opts.dnsZone, "--offline", "--apply",
  ])).toMatchObject({ action: "update", offline: true, apply: true });
});
