# Releasing

One workflow builds the Windows release: **Actions → Release → Run workflow**.
It packages Windows x64 from a single pinned commit, verifies the artifact the
way a user would receive it, assembles a draft on
[orbit-releases](https://github.com/aiedwardyi/orbit-releases), and publishes it
when **publish** is enabled. Leave publish unticked to review the draft first.

The workflow refuses to overwrite an already-published version, so the only
prerequisite per release is that `package.json`'s version is bumped on the
ref you run it against.

## Why the gates exist

Each verification step in `release.yml` maps to a real incident from the
hand-cut releases (0.1.15–0.1.25): stale build output breaking the code
signature, a bare import killing the packaged server on launch while every
check stayed green, helper paths resolving outside the app after bundling,
stapling silently invalidating every published hash, and a finished release
sitting invisible as a draft. Don't remove a gate without reading the comment
above it.

## One-time setup: secrets

Set these in **OpenMausBot → Settings → Secrets and variables → Actions**.

### `RELEASES_PAT`

A fine-grained personal access token that lets the workflow write to the
separate releases repo: **GitHub → Settings → Developer settings →
Fine-grained tokens** → repository access: only `orbit-releases` →
permissions: **Contents: Read and write**. Set a long expiry and a calendar
reminder.

### `WINK_GOOGLE_CLIENT_ID` and `WINK_GOOGLE_CLIENT_SECRET`

The Google "Desktop app" OAuth client for Google sign-in. The release bakes
them into the package (`scripts/write-google-client.mjs`); they never go in
the repo. Without them the build ships with Google sign-in hidden. Local dev
reads env vars with the same names.

### Local fallback

The local path is `pnpm package:win`. Upload `release/*.exe`,
`release/*.exe.blockmap`, and `release/latest.yml`. Publish, and verify the
downloaded bytes against the feed.
