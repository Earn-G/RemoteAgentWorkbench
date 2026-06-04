# Contributing to RemoteAgentWorkbench

Thanks for your interest! This is a small, self-hostable platform with three moving parts — a TypeScript **server** (control plane), a TypeScript **runner** (Mac daemon), and a SwiftUI **iOS/macOS app**. This guide covers local setup, tests, and conventions.

## Prerequisites

- macOS with **Xcode 16+** and the iOS Simulator
- **[XcodeGen](https://github.com/yonaskolb/XcodeGen)**: `brew install xcodegen`
- **Node.js 20+**
- The **[Codex CLI](https://github.com/openai/codex)**, installed and authenticated — only needed to exercise a real plan/implement turn end-to-end
- Optional: **`gh`** (logged in) for GitHub PRs; **`GITLAB_TOKEN`** for GitLab MRs

## Repository layout

| Path | What it is |
|------|------------|
| `server/` | TypeScript control plane (Fastify + SQLite) |
| `runner/` | TypeScript Mac daemon (shells out to Codex + Git) |
| `ios-app/` | SwiftUI iPhone app + companion macOS app (XcodeGen project) |
| `deploy/` | VPS / Caddy / systemd / launchd templates |
| `docs/`, `scripts/` | Docs and helper scripts |

## Local development

Run the server and runner in separate terminals, then the app:

```bash
# server
cd server && npm install && cp .env.example .env && npm run dev   # http://127.0.0.1:8787

# runner (new terminal)
cd runner && npm install && cp .env.example .env && npm run dev

# iOS app
cd ios-app && xcodegen generate && open RemoteAgentWorkbench.xcodeproj
```

The `RUNNER_SHARED_SECRET` in `server/.env` and `runner/.env` must match (both ship as `change-me`). Leave both blank to disable runner auth for local dev.

### Working without a real Codex

The control plane works without Codex: you can exercise runner registration, project sync, task creation, assignment delivery, and status transitions. Driving a **successful** plan/implement turn requires an authenticated Codex CLI on the Mac (the runner shells out to it directly — there is no mock mode).

## Tests & checks

Please run these before opening a PR:

```bash
# server + runner (Node test runner + tsc)
cd server && npm test && npm run build
cd runner && npm test && npm run build

# iOS build
cd ios-app && xcodegen generate
xcodebuild -project RemoteAgentWorkbench.xcodeproj \
  -scheme RemoteAgentWorkbench -destination 'generic/platform=iOS Simulator' build

# iOS unit tests
xcodebuild test -project RemoteAgentWorkbench.xcodeproj \
  -scheme RemoteAgentWorkbench -destination 'platform=iOS Simulator,name=iPhone 16 Pro'
```

## Conventions

- **The Xcode project is generated.** Edit [`ios-app/project.yml`](ios-app/project.yml) and run `xcodegen generate`; do **not** hand-edit `*.xcodeproj/project.pbxproj`. Source files are picked up by folder, so adding/removing a file just needs a regenerate.
- **TypeScript** — keep `tsc` clean and follow the existing patterns in `server/src` and `runner/src`.
- **Swift** — SwiftUI + Combine; follow the existing feature-folder structure under `ios-app/RemoteAgentWorkbench/Features`.
- **Never commit secrets.** Everything matching `.env*` (except `*.env.example`) is gitignored. Do not commit tokens, real hostnames, personal absolute paths, databases, or build artifacts.

## Adding a workflow

The architecture is built to extend along one boundary:

1. Add task command/result types in `server/src/domain/models.ts`
2. Add state-machine branches in `server/src/services/taskService.ts`
3. Add an assignment handler in `runner/src/index.ts`
4. Add the matching iOS form + detail actions

## Pull requests

- Branch from `main` and keep PRs focused.
- Include a short description of the change and how you verified it.
- Make sure the server and runner tests pass and the iOS app builds.
- Call out any new env vars or config in the PR and update the relevant docs.

## Reporting issues

Open a GitHub issue with steps to reproduce, expected vs. actual behavior, and your environment (macOS / Xcode / Node / Codex versions). For security-sensitive reports, please don't paste secrets into a public issue.
