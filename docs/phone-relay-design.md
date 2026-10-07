# Phone from anywhere: relay design

Status: design only, nothing built. Base: `review-base` at f825bdfa. Owner: Edward.
Code references are `file:line` at f825bdfa. "Unverified" marks claims not checked against a primary source or real hardware.

## 1. Summary of decisions

| Topic | Decision |
|---|---|
| Transport PC to relay | One control channel plus a pool of pre-opened per-connection data channels, all TLS to `relay.<base>:443`. No multiplexer. |
| Routing | Relay peeks the phone's ClientHello, reads SNI, splices raw bytes to an idle data channel of that PC. Never decrypts. |
| PC hostname | `<label>.<base>`, label = first 16 chars of base32(SHA-256(PC Ed25519 public key)). Self-certifying, so the relay needs no database. |
| PC auth | Ed25519 signature over a relay nonce plus an operator-signed ticket. Relay is stateless except the operator key. |
| Certificates | Each PC runs ACME in-process with TLS-ALPN-01. The challenge rides the normal SNI route. Key never leaves the PC. |
| Phone TLS | Terminated in Wink's Node server: tunneled socket fed to an in-process `tls.Server`, then `http.Server.emit('connection')` into the existing `handleRequest`. HTTP/1.1 in v1, HTTP/2 after measurement. |
| Phone auth | QR holds a 2 minute single-use pairing token in the URL fragment. Redeeming it sets `__Host-wink_phone`, a per-phone device token, hashed at rest, revocable per phone. |
| Off switch | No `phoneRelay.base` in config means the feature does not exist at runtime. Tailscale path untouched. |

## 2. Architecture

```
phone browser --TLS(SNI=<label>.<base>)--> relay VM :443 (Seoul) --splice--> data channel (TLS to relay)
                                                                                 |
PC: Wink Node server (harness) <-- tls.Server (PC cert) <-- unwrap <-------------+
     ^ control channel (TLS, ALPN wink-ctl/1) keeps PC registered, asks for pool refills
```

- **Phone**: plain browser. Real HTTPS origin `https://<label>.<base>`, so `public/manifest.json` (scope `/`, standalone), `public/sw.js` and web push work per origin unchanged. Push messages go PC to the push service directly (`server/web-push.ts`), never through the relay, so push works even with the relay down.
- **Relay**: one Node 24 process on one e2 VM in asia-northeast3, Standard network tier, port 443 only. It terminates TLS only for its own name `relay.<base>`.
- **PC**: Electron runs the harness (`server/index.ts`). The new relay client lives inside that process. It opens only outbound connections; the harness still listens only on 127.0.0.1 (`server/index.ts:10166`). No new port, no new binary.

## 3. PC to relay protocol

**Choice: control channel plus pooled per-connection data channels.** Reasons:

- Latency: a phone connection costs one TCP handshake phone to relay, then its TLS handshake flows end to end over an already-open data channel. No extra round trip versus a multiplexer, and none per request in steady state (keep-alive inside the phone's TLS).
- Flow control for free: each phone connection maps to its own TCP connection relay to PC, so kernel TCP windows plus `stream.pipeline` give per-connection backpressure. A 1 GB download fills only its own socket buffers; chat on another connection is unaffected. A multiplexer over one TCP connection (yamux, HTTP/2 tunnel) adds TCP head-of-line blocking across all phone connections on packet loss and needs a hand-written credit window in TypeScript, the riskiest code in the design.
- Cost: idle pooled sockets on the relay (cheap) and a refill handshake when a burst drains the pool.

**Channels.** Everything goes to `relay.<base>:443` with SNI `relay.<base>`, so it passes work-network firewalls that only allow 443. The relay terminates this outer TLS with its own WebPKI cert and branches on ALPN:

| ALPN | Purpose |
|---|---|
| `wink-ctl/1` | Control channel, one per PC. |
| `wink-data/1` | Idle data channel waiting for a phone. |
| `acme-tls/1` | The relay's own cert challenge. |
| `http/1.1` | Enroll and status API (section 4, 7). |

**Framing** (both channels until splice): 4 byte big-endian length, then UTF-8 JSON, max 16 KiB.

Control: relay `hello {v:1, nonce}`; PC `auth {label, pk, ticket, sig}` where `sig = Ed25519("wink-relay-auth/1" | nonce | label)`; relay `ready {session, poolToken, pool:{min, max}, ticket?}` (a refreshed ticket when the old one is past half life); relay `want {n}` when a phone waits on an empty pool; `ping`/`pong` every 30 s both ways, 2 missed means dead; relay `notice {code}` for `superseded`, `draining`, `revoked`.

Data: PC sends `join {session, poolToken}` once (token compared with `timingSafeEqual`); relay parks it. When a phone arrives the relay sends `go {peer}` (phone IP, used by the PC only for rate limits, never for trust), writes the buffered ClientHello, then splices both ways. After `go` neither side frames again.

**Pool.** PC keeps `min=3` idle channels, refills one per `go`, and raises to `max=8` for 60 s after a burst (a browser opens up to 6 HTTP/1.1 connections at page load). If the pool is empty the relay holds the phone socket up to 5 s and sends `want`; that case costs one PC to relay TCP plus TLS 1.3 setup (measure it, section 15).

**Byte path rules.** `setNoDelay(true)` on every socket on both hops so small SSE frames are not held by Nagle. No application buffering: the relay uses `stream.pipeline` per direction; SSE already disables proxy buffering (`server/index.ts:7254`) and heartbeats every 15 s (`server/index.ts:2141`), so relay idle timeout is 10 min. Newest valid control connection for a label wins; the old one gets `superseded`.

**HTTP/2.** Phone to PC is end to end, so h2 is a PC-side choice. v1 offers only `http/1.1`: `handleRequest` uses `IncomingMessage`/`ServerResponse` semantics and the http2 compat layer is not identical (forbidden connection headers, `req.socket`). HTTP/1.1 also keeps per-connection TCP isolation. Card B measures; turning on `h2` via `http2.createSecureServer({allowHTTP1:true})` is a follow-up if page load suffers. The ingress `http.Server` sets `keepAliveTimeout` to 65 s so a phone does not redo TLS between taps.

## 4. Registration and auth

- **PC identity**: Ed25519 key pair made with `node:crypto` on first enable, stored in `DATA_DIR/phone-relay/identity.pem` (mode 0600, same handling as `remote-key.json`, `server/remote-access.ts:78`), never synced.
- **Label**: `base32lower(sha256(raw 32 byte pk))[0..16]`, regex `^[a-z2-7]{16}$` (80 bits). A PC can claim only the label its key hashes to, so "only its own hostname" is enforced by math, not a table. Reserved names (`relay`, `www`, `status`) can never match the regex.
- **Ticket**: `wkt1.<b64url(json {label, pk, iat, exp})>.<b64url(Ed25519 sig by operator key)>`, 1 year life, refreshed on connect. The relay verifies with the operator public key from its config and refuses labels in its `revoked-labels` list. No PC database exists on the relay, which is what makes the 90 day account move painless.
- **Enroll** (`POST https://relay.<base>/v1/enroll {invite, pk, sig}`): invite is an operator-signed `{exp: 7 days, nonce}` minted with `relay/scripts/mint-invite.ts`. Used nonces are kept in `/var/lib/wink-relay/used-invites` (lost on account move; harmless since invites expire in 7 days). Launch policy is open question 1.
- **Operator key**: Ed25519, kept by Edward in a password manager, uploaded at provision time as a systemd credential (`LoadCredential=`). Lose it and every PC re-enrolls once; hostnames do not change because they derive from PC keys, so paired phones keep working.

## 5. SNI routing on the relay

Plain `net.Server` on :443. Per socket: read up to 16 KiB or 5 s, parse the ClientHello (`shared/tls-client-hello.ts`, handles records split across TCP segments), lowercase SNI. If SNI is `relay.<base>`, hand the bytes to the local `tls.Server`. If it matches `^[a-z2-7]{16}\.<base>$` and the label has a live session, splice to an idle data channel. Otherwise write a plaintext TLS alert `unrecognized_name` (112) and close; this needs no certificate. No SNI or malformed: close.

## 6. Certificates

- **Challenge**: TLS-ALPN-01 (RFC 8737, port 443 only, [Let's Encrypt challenge types](https://letsencrypt.org/docs/challenge-types/)). The CA connects to the relay with SNI `<label>.<base>` and ALPN `acme-tls/1`; the relay routes it like any phone. The PC peeks the ClientHello with the same shared parser and, when ALPN lists `acme-tls/1`, hands the socket to a second `tls.Server` holding the self-signed challenge cert. HTTP-01 was rejected because it needs port 80 and Host routing on the relay. DNS-01 and wildcard certs are impossible by design: they would need DNS control, which is exactly the trust we keep away from PCs.
- **Client**: `acme-client` npm (MIT, pure JS on `node:crypto` plus `@peculiar/x509`, supports EAB) ([repo](https://github.com/publishlab/node-acme-client)). Its docs do not list TLS-ALPN-01 helpers, so the challenge cert (critical `id-pe-acmeIdentifier` extension) is built with `@peculiar/x509`, about 40 lines. Two new runtime deps; reason: X.509 and JWS by hand is several hundred lines.
- **Keys**: ECDSA P-256 cert key and per-PC ACME account key in `DATA_DIR/phone-relay/` (0600), never synced, never sent anywhere. A shared ACME account across PCs is impossible since its key would be on every PC.
- **Renewal**: check ARI twice a day; fallback renew at one third of lifetime left ([LE integration guide](https://letsencrypt.org/docs/integration-guide/)). ARI renewals are exempt from rate limits ([LE rate limits](https://letsencrypt.org/docs/rate-limits/)). Failure: retry with backoff (1 h, cap 12 h); after 3 failed days switch to the second CA in `phoneRelay.acmeDirectories`. The renewed cert is swapped with `tls.Server.setSecureContext`, no restart.
- **Relay's own cert** for `relay.<base>`: same ACME module, TLS-ALPN-01 answered locally.

## 7. Reconnect, health and Settings status

- Backoff: full jitter, 1 s base, 60 s cap, reset after 60 s connected. DNS is re-resolved on every attempt (no IP caching), so a new relay IP is picked up within the record TTL (300 s). After 1 h of continuous failure the cap rises to 15 min. A timer gap over 30 s (OS sleep) triggers an immediate reconnect. `notice draining` (relay restart) reconnects after 0.5 to 2 s jitter instead of backoff.
- `GET /api/phone-relay/status` (loopback only) returns `{state, host, relayRttMs, poolIdle, certNotAfter, lastError, nextRetryAt}` with `state` in `off | enrolling | certifying | connected | reconnecting | rejected | cert-error`.
- Relay `GET https://relay.<base>/v1/status/<label>` returns `{online, since}` for the phone offline page. This leaks only whether a label (already public in CT logs) is online; accepted.

## 8. Pairing and QR

- **Settings** (Connections, next to `PhoneLinkSettings` at `src/components/SettingsModal.tsx:704`): new `src/components/PhoneAccessSettings.tsx` built from the `Section` primitive the existing `PhoneLinkSettings` uses (`src/components/PhoneLinkSettings.tsx:38`). Rows: toggle "Phone access from anywhere", status line from section 7, invite field when not enrolled, "Add a phone" (QR panel reusing `QRCodeSVG` as in `src/components/PhoneSetupFlow.tsx:1140-1141`, 2 minute countdown, 6 digit code under it), phone list (name, paired, last seen, Remove), Advanced (address, cert expiry, "Reset phone address" which makes a new identity and signs out every phone). The Tailscale row stays as is.
- **Mint**: `POST /api/phone/pairing` (loopback only). Port `DeviceRegistry` from `companion/src/devices.ts:127-340` to `server/phone-devices.ts` with `dataDir` injected: token `wkp_` + 32 random bytes base64url, 6 digit `randomInt` code, TTL 120 s (`:63`), 5 bad guesses burn the window (`:64`, `:246-254`), single use (`:264`), replay recovery by request id (`:225-242`), max 20 phones (`:66`), SHA-256 at rest (`:270`).
- **QR URL**: `https://<label>.<base>/pair#k=<token>`. The fragment never reaches the server or a Referer, and link-preview bots that GET the URL cannot burn the token. The long-lived key is never in the QR.
- **Redeem**: `/pair` is a small static page. Its script reads the fragment, clears it with `history.replaceState`, and POSTs `/api/phone/pair {credential, name, requestId}` (pre-auth route like the mailbox route at `server/index.ts:6378`, relay only, Origin must equal the page). It also offers 6 digit code entry.
- **Cookie**: `__Host-wink_phone=<wkd_ token>; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax`. The `__Host-` prefix forbids `Domain`, so a sibling PC under the same base domain cannot toss a cookie onto this host. 400 days is the browser cap (unverified for Safari); the server re-sets it weekly while used and drops device records idle for 90 days.
- **Revoke**: `DELETE /api/phone/devices/:id` (loopback only) removes the record and destroys that phone's open relay sockets (map device id to sockets at auth time), so a live SSE stream ends now, not at next request.
- **iOS Home Screen**: whether Safari copies cookies into a Home Screen app is unverified. If the installed app opens unpaired it shows the 6 digit code entry, so pairing works either way.

## 9. Trust audit (requirement 5)

The relay ingress `http.Server` marks every socket it accepts (`markRelaySocket`, a `WeakSet`). `isRelayRequest(req)` is socket identity, so no header can fake it. Local and Tailscale Serve traffic both arrive on the loopback listener and are unchanged.

| Site | Trusts today | Rule for relay traffic |
|---|---|---|
| `server/index.ts:6369` Host gate | Loopback Host or tailnet host | Host must equal this PC's relay host exactly. Loopback and tailnet Hosts get 403, so `Host: localhost` over the tunnel gains nothing. |
| `server/index.ts:6373`, `:6351-6359` Origin gate | No Origin passes; loopback origins pass | Origin, when sent, must equal `https://<relay host>`. Non GET/HEAD without Origin gets 403. |
| `server/index.ts:6378` mailbox | `MAILBOX_SECRET` header, before auth | 404 via relay. |
| `server/index.ts:6398-6401`, `server/remote-access.ts:123-130` /api auth | Bearer `COMMS_TOKEN` or `orbit_remote` cookie | Bearer ignored (`bearerOk=false`), `orbit_remote` ignored; only a valid `__Host-wink_phone`. `wink_phone` is ignored off the relay. |
| `server/index.ts:6398` `/api/health` | Public | Public, body reduced to `{ok:true}` (no pid). |
| `server/index.ts:6403-6410` `/remote?key=` | Long-lived key in URL | 404 via relay. |
| `server/index.ts:6414-6430` `/api/internal/*` | Bearer or remote cookie (only terminal-bridge is bearer-only, `server/remote-access.ts:120`) | 404 via relay for the whole prefix. |
| `server/index.ts:6425` terminal bridge URL | Loopback URL check | Unreachable via relay (row above). |
| `server/index.ts:7360` `/api/remote-link` | Any authorized caller gets the long-lived tailnet key | Loopback only. Same for new `/api/phone/pairing`, `/api/phone/devices*`, `/api/phone-relay/*`. |
| `server/config.ts:199` custom key error | `x-openmausbot-companion` header or tailnet Host | Treat `isRelayRequest` as phone. |
| `server/index.ts:10087` VPS join | Client-sent `x-openmausbot-companion` header | Refuse when `isRelayRequest`, regardless of headers. |
| `server/linked-files.ts:247` linked files | Bearer or remote cookie | Pass `bearerOk=false` and the device check via relay. |
| `server/index.ts:1952` device record host | Tailnet host | Unchanged in v1; publishing the relay host for the device picker is a follow-up. |
| `server/early-listen.ts:33` early static | No Host gate | Relay client starts only after `setHandler`/`createServer` (`server/index.ts:10161-10168`). |
| `server/webhook-ingress.ts:157` | Separate loopback listener | Never reachable: relay ingress dispatches only to `handleRequest`. |
| `req.socket.remoteAddress` | Not used for trust today (grep) | Must stay unused; relay sockets have none. |

Rate limits: pairing redeem 10/min per peer IP and 30/min per PC, on top of the 5 guess burn. Relay: phone connections 20/s burst 60 per source IP, 256 concurrent per label, 16 idle data channels per label, 6 control auth attempts/min per IP, enroll 5/h per IP, status 60/min per IP. Relay logs carry event, label, /24 of peer IP, byte counts, duration; never payload, never ClientHello bytes beyond SNI; journald kept 7 days.

## 10. Failure modes

| Situation | PC Settings | Phone |
|---|---|---|
| Relay down | "Relay unreachable, retrying in Ns" | `sw.js` gains a navigation-only fetch handler: network first, and only on network failure it serves a cached `offline.html` (app shell is never cached, keeping the promise at `public/sw.js:1`). Status fetch to the relay fails, so it says "Can't reach the Wink relay", retries every 10 s. |
| PC asleep or Wink closed | n/a | Relay sends `unrecognized_name`; offline page asks `/v1/status/<label>`: "Your PC is asleep or Wink is closed (since 21:04)". |
| Mid-session drop | Reconnecting | SSE resumes via Last-Event-ID (`server/index.ts:2128-2137`). |
| Renewal failing | Warning with days left and error, desktop notification at 14 days | Nothing until expiry, then the browser's certificate error (not stylable). |
| Relay IP or DNS changes | Reconnects within TTL plus 60 s | Offline page until the phone's DNS cache expires. |
| Relay moved to new account | Same as above; no re-enroll (stateless relay, tickets portable) | Same; cookies and certs untouched. |
| Ticket revoked or operator key lost | "Relay access removed, enter an invite" | Offline page. |
| Same identity on two PCs (restored backup) | Older one: "This phone address is in use on another computer" | Talks to newest. |

## 11. Trust caveat: DNS and the relay operator

Whoever controls DNS for `<base>`, or simply runs the relay, can pass TLS-ALPN-01 for any label (route the challenge to itself) and get a valid cert, then man-in-the-middle new phone connections. The relay cannot read traffic passively, but an active operator can. This matches Tailscale Funnel's model, where relays pass encrypted traffic through ([Funnel docs](https://tailscale.com/kb/1223/funnel)) but Tailscale controls the `ts.net` DNS. Mitigations:

- Detection on the PC (v1: yes). Once a day the PC queries Certificate Transparency (crt.sh JSON, unverified reliability) for its hostname and compares each cert's SPKI with keys it generated (it keeps a history). An unknown cert shows a red Settings warning and a desktop notification. Phones cannot detect this.
- CAA records on `<base>` limiting issuance to the configured CAs (stops other CAs, not the DNS owner).
- Not in v1: CAA `accounturi` per host (needs DNS writes per PC).

## 12. Where it lives

| Path | What |
|---|---|
| `shared/relay-protocol.ts` | Frame codec, message types, ALPN ids, label derivation, ticket sign/verify. Imported by relay and server. |
| `shared/tls-client-hello.ts` | `parseClientHello(buf) -> {sni, alpn} \| "more" \| "invalid"`. |
| `relay/` (new workspace package, like `cloudflare/control-plane/`) | `src/` router, pools, control, enroll, status, limits; `scripts/mint-invite.ts`; `deploy/provision.sh`, `deploy/update.sh`, `deploy/teardown.sh`, `deploy/wink-relay.service`; own vitest config. |
| `server/phone-relay/` | `client.ts` (control, pool, backoff), `ingress.ts` (tls.Server, ALPN peek, http.Server), `acme.ts`, `ct-watch.ts`, `via.ts` (`markRelaySocket`, `isRelayRequest`). |
| `server/phone-devices.ts` | Ported `DeviceRegistry`. |
| `src/components/PhoneAccessSettings.tsx`, `public/pair.html`, `public/offline.html`, `public/sw.js` | UI. |

Config (`~/.openmausbot/config.json`): `phoneRelay.base` (empty means feature absent; shipped builds default empty), `phoneRelay.enabled` (user toggle), `phoneRelay.acmeDirectories` (default Let's Encrypt, then Google Trust Services with EAB). Env `ORBIT_RELAY=0` forces off. The base domain is never hardcoded.

## 13. Relay deploy, update, move, pause

- `relay/deploy/provision.sh --project P --base wink.edwardyi.dev --operator-key FILE [--machine e2-small]` with `NAMECOM_USER`/`NAMECOM_TOKEN` in env: enables Compute, reserves a regional static IP with `--network-tier=STANDARD` in asia-northeast3, firewall 443 from anywhere and 22 only from IAP, creates a Debian 12 VM (10 GiB pd-balanced, Standard tier NIC), installs a pinned Node 24 tarball after checking SHASUMS256, copies an esbuild bundle of `relay/`, installs `wink-relay.service` (DynamicUser, NoNewPrivileges, `AmbientCapabilities=CAP_NET_BIND_SERVICE`, `LimitNOFILE=1048576`, `LoadCredential=operator.key`), upserts `*.<base>` A record TTL 300 via the name.com API (endpoint details unverified), waits for DNS, curls `https://relay.<base>/v1/healthz`.
- Update: `update.sh` rebuilds, copies, `systemctl restart`; on SIGTERM the relay sends `draining`, PCs reconnect in about 2 s, phones see one SSE reconnect.
- Move to a new account: run `provision.sh` on the new project, then `teardown.sh` on the old one. Nothing on PCs changes.
- Pause: `teardown.sh` deletes VM, IP, firewall and the DNS records (so a recycled IP never answers for `<base>`). PCs back off to 15 min retries; Wink works as today. Shipped builds keep `phoneRelay.base` empty until launch.
- Standard tier availability in asia-northeast3 is unverified; if absent, Premium pricing applies (section 14).

## 14. Launch limits and cost

**Issuance.** Let's Encrypt: 50 new certificates per registered domain per 7 days, override by form taking several weeks; 300 new orders per account per 3 h; 5 failed authorizations per identifier per account per hour; ARI renewals exempt ([LE rate limits](https://letsencrypt.org/docs/rate-limits/)). Under `edwardyi.dev` the whole service gets 50 new PCs a week. Plan: (1) submit the LE override form 6+ weeks before launch; (2) second CA: Google Trust Services ACME (`https://dv.acme-v02.api.pki.goog/directory`, EAB from `gcloud publicca external-account-keys create`, [GCP docs](https://docs.cloud.google.com/certificate-manager/docs/public-ca-tutorial); its quotas unverified); (3) a Public Suffix List entry for cookie and storage isolation between users. The PSL refuses entries whose sole purpose is LE limits, has no SLA, and wants the domain registered 2+ years ahead ([PSL guidelines](https://github.com/publicsuffix/list/wiki/Guidelines)). See open question 2.

**Relay capacity.** Each PC holds 1 control plus 3 idle sockets. 10,000 PCs is about 40,000 TLS sockets; at an assumed 20 to 50 KiB each that is 0.8 to 2 GiB (unverified, Card A load test decides). The relay does one AES-GCM layer per byte (outer TLS); phone TLS is spliced. Estimate: e2-micro to 100 PCs, e2-small to 1,000, e2-standard-2 to 10,000.

**Traffic assumption: 1 GiB per active user per month.** About 10 phone opens a day at about 2 MB each (slim message pages, `server/index.ts:2056-2062`; phones skip screen frames, `server/index.ts:2121-2124`) is about 0.6 GiB, plus about 0.4 GiB attachments and downloads. Keepalives add about 0.02 GiB per PC (30 s pings, TCP keepalive on idle channels). Both directions out of the relay are egress; ingress is free.

Monthly, Standard tier, 730 h, 10 GiB pd-balanced ($1.30), external IP ($3.65):

| Active users | VM | VM + disk + IP | Egress | Total |
|---|---|---|---|---|
| 0 (paused, torn down) | none | $0 | $0 | **$0** |
| 10 | e2-micro $7.85 | $12.80 | 10 GiB, within 200 free | **$12.80** |
| 1,000 | e2-small $15.69 | $20.64 | 800 x $0.119 = $95.20 | **$115.84** |
| 10,000 | e2-standard-2 $62.77 (2 x $0.02803 + 8 x $0.00374, x 730) | $67.72 | 9,800 x $0.119 = $1,166.20 | **$1,233.92** |

Egress dominates from about 500 users. On Premium tier, 1,000 users would cost $190 in egress alone. The e2-micro free tier does not cover Seoul (unverified).

## 15. Build plan

Three cards, parallel. Interfaces fixed now: `shared/relay-protocol.ts` and `shared/tls-client-hello.ts` (written first by Card A as a small PR with tests, both other cards build against it), `server/phone-relay/via.ts` (Card C writes `markRelaySocket`/`isRelayRequest`; Card B calls `markRelaySocket`), `startPhoneRelay({dataDir, config, handler, onStatus}) -> {status(), stop()}` and the status JSON in section 7 (Card B exports, Card C renders). All tests follow CONTRIBUTING: no sleeps, fake clocks, temp HOME.

**Card A: relay and deploy.** Owns `shared/`, `relay/`. Tests: ClientHello parser (fragmented records, no SNI, oversize, fuzz corpus), SNI routing and `unrecognized_name`, auth (bad sig, wrong label for key, expired or revoked ticket, newest wins), pool token checks, rate limits, backpressure (a paused reader on one spliced pair does not delay another), a log-sink test asserting no payload bytes reach logs, provision dry-run plus shellcheck, a load test of 10,000 synthetic PCs for sizing.

**Card B: PC tunnel and certificates.** Owns `server/phone-relay/{client,ingress,acme,ct-watch}.ts`, the wiring in `server/index.ts` after `setHandler`. Tests against an in-process fake relay built on the shared protocol: double TLS plus `emit('connection')` serves `handleRequest` (Node allows injecting any Duplex, [Node http docs](https://nodejs.org/api/http.html)); SSE frames arrive unbuffered; backoff, DNS re-resolve and sleep-gap reconnect with fake timers; `acme-tls/1` gets the challenge cert; renewal swap via `setSecureContext`; CA fallback; off when `base` is empty. Manual run against LE staging.

**Card C: trust, pairing, UI.** Owns `via.ts`, `server/phone-devices.ts`, every row of section 9 in `server/index.ts`, `server/config.ts`, `server/linked-files.ts`, the pairing routes, Settings, `pair.html`, `offline.html`, `sw.js`. Tests: an `index.test.ts` smoke per audit row with sockets injected through a test relay ingress, cookie attributes, TTL, 5 guess burn, single use, revoke ends a live SSE stream, Tailscale path unchanged with relay on and off. Screenshots per CONTRIBUTING.

**Measure on real hardware after deploy** (Edward's 3 PCs, phones on SKT, KT, LG U+ LTE/5G and home Wi-Fi, 200 samples, median and p95):

1. TCP connect, TLS handshake, TTFB of `GET /api/health`, and SSE emit to phone receipt: relay vs Tailscale direct, same phone and PC. Target: relay median within 15 ms of Tailscale direct.
2. Chat send to SSE echo p95 while a 1 GB download runs on the same phone: within 20% of idle.
3. Cold open from lock screen to first paint; pool-empty cost (6 parallel connections).
4. Reconnect time after PC sleep, relay restart, relay IP change.
5. iOS: cookie carried into the Home Screen app or not, web push from the Home Screen app.
6. Relay RSS, sockets and CPU with 3 PCs idle and busy.

## 16. Open questions for Edward

1. **Who may enroll a PC at launch?** Recommended: operator-signed invites now (you mint 3); at launch, automatic enroll with per-IP limits and a weekly global cap matched to CA capacity.
2. **Launch domain?** Recommended: keep `wink.edwardyi.dev` for testing, buy a dedicated domain registered for 3+ years before launch, file the PSL entry (justified by cookie isolation between users), and the LE override form.
3. **Hostname shape?** Recommended: random 16-char labels derived from the PC key (not personal in public CT logs, no squatting, stateless relay) rather than readable names like `edward-home`, which need a name registry on the relay.
