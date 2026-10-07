# Wink phone relay

Encrypted byte relay for phone access from anywhere (`docs/phone-relay-design.md`, sections 3 to 5, 7, 9 and 13).
A phone's TLS goes end to end to its PC; the relay reads only the ClientHello (SNI, ALPN) and splices raw bytes.
It terminates TLS only for its own name `relay.<base>`, and never holds a PC's TLS key.

## Commands

Node 24 and this package's own lock (`pnpm install --ignore-workspace` inside `relay/` until the workspace entry lands).

```sh
pnpm check     # tsc, no emit
pnpm test      # vitest, loopback TLS only, temp dirs and fixture certificates
pnpm build     # dist/wink-relay.mjs and dist/mint-invite.mjs (esbuild, self contained)
pnpm mint-invite --key-file <operator key file> [--ttl-days 7]
node scripts/gen-operator-key.ts --out <new private file>
WINK_SIZING=500 NODE_OPTIONS=--expose-gc pnpm vitest run test/sizing.test.ts --disableConsoleIntercept   # synthetic, capped at 2000 PCs
```

## Layout

| Path | What |
|---|---|
| `src/relay.ts` | `createRelay()`: TCP listener, ClientHello peek, SNI/ALPN routing, TLS for `relay.<base>`, drain on close. |
| `src/channels.ts` | Control (`wink-ctl/1`: hello, auth, ready, ping, notices) and data (`wink-data/1`: join) channels. |
| `src/hub.ts`, `src/splice.ts` | Sessions, pools, waiting phones, `go` + buffered bytes, per-pair backpressure. |
| `src/enroll.ts`, `src/invites.ts` | `POST /v1/enroll`, single-use invites stored as nonce hashes. |
| `src/http.ts` | `/v1/healthz`, `/v1/status/<label>`, `/v1/enroll`, only for Host `relay.<base>`. |
| `src/acme.ts` | `relay.<base>` certificate via ACME TLS-ALPN-01 (acme-client 5.4.0 `createAlpnCertificate`). |
| `src/log.ts` | Allowlisted, shape-checked log fields only. |
| `deploy/` | Planner, executor, `wink-relay.ps1`, `wink-relay.sh`, VM installer, systemd unit. |

## Enrollment signature

`sig = Ed25519(pc key, UTF-8 JSON.stringify(["wink-relay-enroll/1", invite, pk]))`, base64url.
`signEnrollment()` and `enrollPayload()` in `src/enroll.ts` are the PC-side helpers.

## Config (`/etc/wink-relay/config.json`)

```json
{
  "base": "<base domain>",
  "listen": { "host": "::", "port": 443 },
  "dataDir": "/var/lib/wink-relay",
  "revokedLabelsFile": "/etc/wink-relay/revoked-labels",
  "acme": { "directoryUrl": "https://acme-v02.api.letsencrypt.org/directory", "termsOfServiceAgreed": true }
}
```

The operator key comes from systemd `LoadCredential=operator.key` (`$CREDENTIALS_DIRECTORY`), or `operatorKeyFile` outside systemd.
`SIGHUP` (`systemctl reload wink-relay`) re-reads the revoked labels; the file is also polled every minute.
Missing or unreadable revocation files retain the last good list and log `revocation-reload-failed`.
An explicit empty file clears the list. Used invite hashes expire after the clock-skew window;
runtime writes compact the journal without dropping unexpired consumes.

## Deploy

Dry run unless `--apply` (`-Apply`). Every run prints the full plan first.

```powershell
.\relay\deploy\wink-relay.ps1 provision -Project <project> -Base <base> -DnsZone <zone> -OperatorKey <file> -AcceptAcmeTerms
.\relay\deploy\wink-relay.ps1 update    -Project <project> -Base <base> -DnsZone <zone>
.\relay\deploy\wink-relay.ps1 move      -FromProject <old> -Project <new> -Base <base> -DnsZone <zone> -OperatorKey <file> -AcceptAcmeTerms
.\relay\deploy\wink-relay.ps1 pause     -Project <project> -Base <base> -DnsZone <zone>
```

Defaults: region `asia-northeast3`, zone `<region>-a`, Standard network tier, `e2-small`, prefix `wink-relay`,
address `<prefix>-ip` (`-AddressName`), DNS `namecom` (`-Dns namecom|manual`).
DNS credentials for `namecom`: `NAMECOM_USER` and `NAMECOM_TOKEN` in the environment; `manual` needs none.

- Resources created carry the description `wink-relay-owned:<base>`; pause and move delete only those.
- An existing address (`-AddressName`, e.g. `wink-relay`) is reused only if its project, region and tier match and
  nothing else uses it; one without the owner marker is never released by pause or move.
- `-Dns manual` never calls name.com: provision stops with the record to add (`A *.<sub> -> <ip>, TTL 300`) until a
  random name under `<base>` resolves to the address at 8.8.8.8 and 1.1.1.1; re-run it once added. Pause refuses
  release without a complete relay/PC DNS inventory; use `-Dns namecom` for that step.
- Files go to the login home as `<vm>:.`, since pscp (gcloud scp on Windows) does not expand `~`.
- The operator key is scp'd as `~/operator.key.upload`, installed 0400 root and shredded, because ssh over IAP
  from Windows does not forward stdin.
- The VM is created with `enable-guest-attributes=TRUE` so host keys are published at first boot and the first
  non-interactive scp/ssh does not stop at a host-key prompt; setting it later is too late.
- Provision enables `iap.googleapis.com` next to compute, for IAP TCP forwarding.
- Pause removes wildcard, explicit relay and PC-label A records at the old IP before releasing it. Move provisions the new project,
  points DNS at it, checks health, then pauses the old project; records already on the new IP are never deleted.
- The VM has no service account and no scopes; SSH is only through IAP (`35.235.240.0/20`, priority 1000) with OS Login.
  An owned `<prefix>-deny-admin` rule (tcp:22,3389 from anywhere, priority 1100) overrides the default network's
  `default-allow-ssh`/`-rdp`, which the tool does not delete.
- Node `v24.21.0` linux-x64 is verified by a pinned sha256 on the deploying machine and again on the VM.
- Deploying account needs roughly: `roles/serviceusage.serviceUsageAdmin` (once), `roles/compute.instanceAdmin.v1`,
  `roles/compute.networkAdmin`, `roles/compute.securityAdmin`, `roles/iap.tunnelResourceAccessor`, `roles/compute.osAdminLogin`.

Not verified against live services: name.com API v4 record shapes, gcloud flag behavior on a real project
(including Standard tier in `asia-northeast3` and the `default` network), the systemd sandbox options with Node 24 on Debian 12, and Let's Encrypt issuance.
