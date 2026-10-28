# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security problem. Report it privately through GitHub:

https://github.com/aiedwardyi/Wink/security/advisories/new

Wink is maintained by one person. Reports get a best-effort response, and a fix ships in a release once it is ready.

## Supported versions

The latest release on [aiedwardyi/orbit-releases](https://github.com/aiedwardyi/orbit-releases/releases/latest). Older versions are not patched; the app offers each new release as an update.

## Scope

The README section [Trust and security](README.md#trust-and-security) is the source of truth for what Wink listens on, sends and stores, and for how approvals and workers are gated. A behavior that contradicts it is a bug, and if it exposes data or control it is a vulnerability.

In short:

- The server binds `127.0.0.1` behind a per-launch token and a Host/Origin check. Any way for another local user to drive it is in scope, and so is any remote way in beyond the phone access the README describes.
- API keys are write-only through the API. Any path that echoes a stored key is in scope.
- Engine CLIs run with your privileges and spawn with argv, never a shell string. Any user-influenced value interpolated into a shell command is in scope. Text typed into a Wink terminal runs in that shell by design.
- Approval modes and the permission broker are the consent layer. Any approval the mode you set doesn't allow is in scope. Auto approving every tool request in a turn you started is documented behavior. On this PC's own screen, destructive or secret-reading actions still ask.
- The installer is not code-signed yet. SmartScreen warnings are a known limitation, not a vulnerability.
