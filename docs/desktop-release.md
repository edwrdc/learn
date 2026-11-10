# Desktop builds (local Fedora RPM)

The desktop app ships as one Fedora Linux x86_64 RPM. Everything runs on the local Fedora host. Nothing is built or checked on GitHub, and nothing is uploaded or published. Installed copies do not check for updates; upgrade by installing a newer RPM.

## What the pipeline produces

| Artifact | Where | Installed as |
|---|---|---|
| `LearnHarness-<version>-x86_64.rpm` | `<checkout>/dist/` after a successful `npm run desktop:act` | system RPM, run by the desktop launcher |

The RPM contains the Electron shell plus the curated standalone server payload. The app keeps the identity `com.learnharness.LearnHarness` / `learnharness.desktop`, and user data stays under the Electron `userData` directory (`data/` and `auth.json`). None of that changed with the packaging move.

## Prerequisites

- Fedora x86_64. The workflow's first step reads `/etc/os-release` and `uname -m` and fails on any other distribution or architecture, so a runner label cannot falsely claim Fedora.
- `act` on `PATH`. The local checks use version 0.2.94. No `.actrc` is used.
- `xvfb-run` from `xorg-x11-server-Xvfb`. The packaged demo smoke needs a display; without it the package job fails. The prerequisite is not skipped.
- `rpmbuild` from `rpm-build`, and `libxcrypt-compat` for the bundled FPM Ruby runtime's `libcrypt.so.1` dependency. The `package` job checks them together with `xorg-x11-server-Xvfb` before it installs or builds anything.
- Network access for action clones, npm dependencies, the Node 26 toolchain, and electron-builder's FPM bundle. Downloads can use `~/.cache/act` and `~/.cache/electron-builder`, but offline operation is not guaranteed.
- No GitHub token and no signing secrets. Leave `GH_TOKEN`, `CSC_*`, and `APPLE_*` out of the calling shell. act executes host steps directly, so exported values are visible to the build.

act runs the jobs directly on the host through `-P fedora-44-x64=-self-hosted`. There is no container and no image to maintain. The tradeoff is that the build can write the checkout and host caches, and it has no isolation from the calling environment.

## Commands

```sh
npm run desktop:act                    # quality gates, then build and copy the RPM
npm run desktop:act -- -j quality      # quality gates only, no packaging
npm run desktop:dist                   # the same build locally, without act
```

`desktop:act` invokes:

```sh
act workflow_dispatch -W .act/workflows/fedora.yml -P fedora-44-x64=-self-hosted --env "LH_OUTPUT_DIR=$PWD/dist"
```

act gives every job an empty temporary workspace and deletes it when the run ends. The `package` job copies the RPM to `$LH_OUTPUT_DIR`, which the caller computes as the checkout's `dist/` directory. The destination is created when missing, and the job fails if `dist/` does not hold exactly one RPM.

**Copy installer output out of `dist/` before the next build.** `desktop:dist` starts with `rm -rf dist`, so a later local build deletes a previously copied RPM. Keep a released RPM somewhere else.

Do not use `act -n` as a preflight. It still executes host steps and can run `actions/setup-node` and `npm ci` for real. `act -l` is safe and only lists jobs.

## Jobs

`.act/workflows/fedora.yml` has two jobs, both on the mapped `fedora-44-x64` host. Each job checks out the local working tree, installs Node 26 with `actions/setup-node@v7`, and runs `npm ci` itself.

`quality` runs `npm run typecheck`, `npm test`, and `npm run lint`.

`package` needs `quality` and then runs the full desktop pipeline:

1. The native PDF/SVG/browser-service renderer tests in Electron's bundled Node, with no display.
2. `npm run desktop:dist`, the single packaging owner. It runs `vite build`, `scripts/build-server.mjs`, the packaged server smoke (`scripts/smoke-server.mjs`) and the carrier smoke (`scripts/smoke-carrier.mjs`), then runs the server and carrier smokes again on Electron's bundled Node with `--electron` (production starts the server there, not under the host Node), then `electron-builder --linux --x64 --publish never`.
3. The packaged provider smoke (`scripts/smoke-provider-runtime.mjs`) against `dist/linux-unpacked/resources/server/standalone`, first with the host Node and then with the packaged `dist/linux-unpacked/learnharness` runtime.
4. The packaged demo smoke (`scripts/smoke-demo-runtime.mjs --browser`) under `xvfb-run`, using the app's own Electron instead of system Chrome.
5. The RPM copy to `$LH_OUTPUT_DIR`.

The server and carrier smokes share `scripts/smoke-harness.mjs`, which copies the payload outside the checkout and boots it the way `electron/main.cjs` does, so a package missing from the payload cannot resolve from the checkout's `node_modules`.

The browser interaction suite (`npm run test:browser`) stays separate and manual. It needs the `agent-browser` CLI, as described in the [development guide](development.md#browser-verification).

## Payload rules

`scripts/build-server.mjs` curates `dist-server/standalone/`: the adapter output and its launcher, the runtime dependency closure, and the prompt assets. The curated payload ships outside the asar, because native binaries cannot be loaded from a read-only archive.

The script refuses a payload carrying `data/`, `auth.json`, `.env*`, the checkout, or a missing platform-native binary. Keep those checks. They are what stops a user's data or keys from ending up inside an installer.

**Do not cross-build the payload.** It copies the build machine's native binaries verbatim, so the payload must be built on the same platform that runs it. The Fedora RPM is therefore built from a Linux payload on the same Fedora machine.

The launcher (`scripts/server-launch.mjs`, copied to the payload's `server.js`) defaults to loopback and the server has no request authentication. Keep it that way: turn handles, the turn queue, and the event bus are process-local, so a serverless adapter or multiple workers would break them. The launcher stamps `x-forwarded-proto: http` so SvelteKit's CSRF check sees the plain-HTTP origin; CSRF stays enabled.

## Inspect, install, and upgrade

Inspect the RPM before installing it:

```sh
rpm -qpi dist/LearnHarness-*-x86_64.rpm
rpm -qlp dist/LearnHarness-*-x86_64.rpm | grep learnharness.desktop
```

Install or upgrade it by hand:

```sh
sudo dnf install ./dist/LearnHarness-<version>-x86_64.rpm
```

Installing a newer RPM upgrades the packaged app. There is no in-app updater, no update feed, and no download banner: the app makes no update requests. Uninstalling leaves user data in the Electron `userData` directory.

RPM installation, elevation, SELinux behaviour, desktop integration, and upgrade persistence need a hand run on a Fedora machine. They are not exercised by the pipeline.

## Limits

- Only an x86_64 RPM is produced. There is no AppImage, `.deb`, DMG, ZIP, or NSIS installer, and no ARM build.
- Only the Fedora host is exercised. macOS and Windows builds cannot be verified here.
- act runs on the host without isolation and ignores workflow `permissions`, `concurrency`, and job timeouts. Nothing relies on those declarations.
- The full act run installs dependencies twice, once per job.
- Jobs run locally but still need network access for actions, dependencies, and build tools. Caches can reduce downloads; they do not make the workflow offline.
