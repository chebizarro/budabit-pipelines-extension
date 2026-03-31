# Budabit CI/CD Pipelines Extension

A Flotilla Smart Widget extension that provides a full CI/CD pipeline management interface for Nostr-native Git repositories. Users can view workflow run history, inspect live job status, and trigger new runs — all powered by Nostr events and the Loom compute protocol.

## How It Works

### Nostr Event Architecture

The pipelines extension is built entirely on Nostr events. There is no central CI server — workflow runs are represented as a chain of signed Nostr events published to relays, and remote workers pick up jobs via those same relays.

```
┌─────────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  User (Flotilla)    │       │  Nostr Relays    │       │  Loom Worker    │
│                     │       │                  │       │                 │
│  1. Create kind     │──────▶│  5401 run event  │──────▶│  Picks up job   │
│     5401 run event  │       │  5100 job event  │       │  Clones repo    │
│  2. Create kind     │──────▶│                  │       │  Runs `act`     │
│     5100 loom job   │       │                  │       │                 │
│                     │       │  ◀──────────────────────│  3. Publishes:  │
│  4. Sees updates    │◀──────│  30100 status    │       │     30100 status│
│     in real time    │       │  5402 wf result  │       │     5402 result │
│     via WebSocket   │       │  5101 loom result│       │     5101 result │
└─────────────────────┘       └─────────────────┘       └─────────────────┘
```

### Event Kinds

| Kind | Name | Direction | Purpose |
|------|------|-----------|---------|
| **5401** | Workflow Run | User → Relay | Declares a new CI run. Contains repo address (`#a`), workflow path, branch, commit, and triggering pubkey. |
| **5100** | Loom Job | User → Relay → Worker | Dispatches a compute job to a specific worker. References the 5401 run via `#e` tag. Contains the command, args, env vars, encrypted secrets, and a Cashu payment token. |
| **5402** | Workflow Result | Worker → Relay → User | Published by the runner script after `act` completes. Contains status (success/failed), duration, exit code, and a Blossom URL to the full act log. |
| **5101** | Loom Result | Worker → Relay → User | The Loom worker's own result event. Contains exit code, stdout/stderr Blossom URLs, and optionally a Cashu change token (refund for unused compute time). |
| **30100** | Loom Status | Worker → Relay → User | Replaceable status updates from the worker during execution (e.g., `queued`, `running`, `success`). |
| **10100** | Worker Advertisement | Worker → Relay | Workers advertise themselves with name, architecture, pricing, supported mints, and queue depth. The extension queries these to populate the worker picker. |

### Event Chain

When a user triggers a run, the extension creates two events in sequence:

1. **Kind 5401** (Workflow Run): Signed via the host's signer, published to the repo's relays. The signed event's `id` becomes the **run ID** — the primary identifier for the entire pipeline execution.

2. **Kind 5100** (Loom Job): Also signed via the host. References the run ID in an `['e', runId]` tag. Contains:
   - `['p', workerPubkey]` — which worker should execute this
   - `['cmd', 'bash']` + `['args', ...]` — the runner script (inlined as a bash heredoc)
   - `['payment', cashuToken]` — prepaid Cashu token for the worker
   - `['env', key, value]` tags — environment variables (repo URL, branch, commit, relay list)
   - `['secret', key, encryptedValue]` tags — NIP-44 encrypted secrets (the ephemeral nsec, user-provided secrets)

The worker picks up the 5100 event, executes the command, and publishes status/result events back to the same relays.

### Worker Discovery

Workers are discovered by querying **kind 10100** events from the repo's relays. Each worker advertisement contains:
- Name, description, architecture (e.g., `x86_64`)
- Supported `act` version
- Pricing (per-second rate, accepted Cashu mints)
- Queue depth and concurrency limits
- Online status (derived from recency of the advertisement)

Workers are sorted by online status and queue depth. The user selects a worker from the picker before submitting a run.

### Secrets and Encryption

The extension generates an **ephemeral keypair** for each run. The ephemeral secret key is NIP-44 encrypted to the worker's pubkey and passed as the `HIVE_CI_NSEC` secret. The runner script uses this nsec to:
- Upload the act log to Blossom (authenticated upload)
- Publish the kind 5402 workflow result event

User-provided secrets (e.g., API keys) are also NIP-44 encrypted to the worker and passed as `['secret', key, ciphertext]` tags.

All encryption is delegated to the host via the `nostr:nip44Encrypt` bridge handler — the extension never accesses `window.nostr` or any private key material directly.

### Payment Flow

Runs are prepaid with **Cashu tokens**. The extension:
1. Queries the user's Cashu wallet balance via the host bridge
2. Shows compatible mints (intersection of user's mints and worker's accepted mints)
3. Generates a Cashu token for the selected amount and mint
4. Includes the token in the 5100 event's `['payment', token]` tag

If the run finishes early, the worker may return a **change token** in the 5101 result event's `['change', token]` tag.

### Real-Time Updates

The extension uses **Nostr's native pub/sub** for live updates — no polling:

1. On load, it does a one-time `nostr:query` to fetch existing runs and their associated events.
2. It then opens a persistent `nostr:subscribe` WebSocket subscription filtering for kinds `[5401, 5100, 5402, 5101, 30100]` with the repo's `#a` tag.
3. Incoming events are **merged directly into local state** via `mergeEventIntoRuns()` / `mergeEventIntoDetail()` — no additional relay queries are triggered.
4. When viewing an active run, a second narrower subscription is opened with `#e` filters for the specific run and loom job IDs.

### Runner Script

The extension generates a **bash runner script** that is inlined into the loom job's args. The script:

1. Clones the Nostr repository using `ngit` (Nostr-native git)
2. Checks out the specified branch and commit
3. Runs GitHub Actions workflows using [`act`](https://github.com/nektos/act)
4. Uploads the act log to Blossom (content-addressed storage)
5. Publishes a kind 5402 workflow result event with status, duration, and log URL

The script template is auto-generated based on the selected workflow, worker, and branch, but can be manually edited before submission.

### Host Bridge Integration

The extension runs as an iframe and communicates with Flotilla via the **Widget Bridge** protocol (`postMessage`-based). It delegates all privileged operations to the host:

| Bridge Action | Purpose |
|--------------|---------|
| `nostr:query` | Fetch existing events from relays |
| `nostr:publish` | Sign unsigned events with the host's signer and publish to relays. Returns the signed event's `id`. |
| `nostr:subscribe` | Open persistent WebSocket subscriptions. Events stream back via `nostr:subscription:event` bridge events. |
| `nostr:nip44Encrypt` | Encrypt plaintext to a recipient pubkey using the host's NIP-44 signer. |
| `context:getRepo` | Fetch repository context (pubkey, name, naddr, relays). |
| `repo:listWorkflows` | List `.github/workflows/*.yml` files from the git repo. |
| `repo:getBranches` | Get branch list and default branch. |
| `storage:get/set` | Persist extension state (repo-scoped). |
| `ui:toast` | Show toast notifications in the host UI. |

The user's pubkey is provided by the host via `context:update` / `widget:init` events. The extension never uses `window.nostr` or NIP-07 directly — all signing is handled transparently by the host.

### Declared Permissions

The widget's kind 30033 manifest declares these permissions:

```
nostr:publish, nostr:query, nostr:subscribe, nostr:nip44Encrypt, ui:toast
```

Flotilla enforces these — bridge requests for undeclared actions are rejected.

## Features

- **View workflow runs** — Browse all pipeline executions with status indicators, duration, and branch info
- **Real-time status** — Live updates via Nostr WebSocket subscriptions, no polling
- **Inspect run details** — Full event chain (run → job → status → result), parsed act logs, stdout/stderr
- **Trigger new runs** — Select workflow, branch, worker, and payment amount
- **Rerun failed jobs** — Reuse prior job metadata with fresh payment and secrets
- **Worker discovery** — Live worker advertisements with pricing, queue depth, and mint compatibility
- **Cashu payments** — Wallet-aware mint selection, auto-token generation prompts
- **Search and filter** — Find runs by name, status, branch, commit, or actor

## Quick Start

### 1) Install

```bash
pnpm install
```

### 2) Run the iframe app locally

```bash
pnpm dev
```

The widget iframe app will be available at `http://localhost:5173`.

### 3) Build

```bash
pnpm build
```

### 4) Generate Smart Widget manifest (kind 30033)

```bash
pnpm manifest:generate
```

This writes `dist/widget/event.json` (unsigned kind 30033), `dist/widget/widget.json`, and `dist/widget/PUBLISHING.md`.

## Project Structure

```
budabit-pipelines-extension/
├── packages/
│   ├── shared/          # Framework-agnostic bridge types + signaling helpers
│   ├── iframe-app/      # Svelte 5 iframe app (the actual widget UI)
│   │   └── src/
│   │       ├── App.svelte           # Main component: run list, detail panel, submission forms
│   │       └── lib/
│   │           ├── pipelines.ts     # Nostr event querying, parsing, and real-time merge logic
│   │           ├── nip07.ts         # Event construction, bridge-delegated signing + encryption
│   │           ├── subscriptions.ts # Persistent Nostr WebSocket subscriptions via bridge
│   │           ├── controllers.ts   # Orchestrates bridge calls for each user action
│   │           ├── view-model.ts    # Composes controllers into UI state transitions
│   │           ├── runner-script.ts # Generates the bash runner script for act
│   │           ├── context.ts       # Transforms host repo context into normalized form
│   │           ├── widget-lifecycle.ts # Bridge setup, context fetching, lifecycle events
│   │           ├── types.ts         # All TypeScript interfaces
│   │           ├── wallet.ts        # Cashu wallet queries via bridge
│   │           ├── payment.ts       # Cashu token parsing
│   │           ├── submission.ts    # Worker/mint selection logic
│   │           ├── submission-state.ts # Form state initialization
│   │           ├── detail-session.ts   # Run detail panel state machine
│   │           ├── presentation.ts  # Formatting helpers (time, duration, status badges)
│   │           ├── wallet-prompt.ts # Auto-token generation prompt logic
│   │           ├── cicd.ts          # YAML workflow parser, act log parser
│   │           ├── repo.ts          # Repo metadata loading (workflows, branches)
│   │           └── components/      # Svelte sub-components
│   ├── manifest/        # CLI: generates kind 30033 + widget.json
│   ├── worker/          # Worker bridge stub
│   └── test-utils/      # Bridge mocks for testing
├── docs/                # Documentation
├── e2e/                 # Playwright E2E tests
└── [config files]
```

## Bridge Protocol

Flotilla uses an action-based `postMessage` protocol:

- **Widget → Host requests**: `{ type: 'request', id, action, payload }`
- **Host → Widget responses**: `{ type: 'response', id, action, payload }`
- **Host → Widget events**: `{ type: 'event', action, payload }`

The shared package provides a typed `WidgetBridge` with:
- `request(action, payload)` → `Promise<response>`
- `onEvent(action, handler)` — for host-initiated lifecycle events
- `onRequest(action, handler)` — for bidirectional tool interactions

### Lifecycle Events

| Event | When |
|-------|------|
| `widget:init` | Bridge ready, includes host version and optional repo context |
| `widget:mounted` | Widget is visible in the DOM |
| `widget:unmounting` | Widget is about to be removed |
| `context:update` / `context:repoUpdate` | Repository context changed (navigation) |
| `nostr:subscription:event` | Incoming Nostr event from a persistent subscription |

## Documentation

Extended docs in `docs/`:
- [Architecture](./docs/architecture.md) — System design and package structure
- [Host Bridge](./docs/host-bridge.md) — Host integration guide
- [Lifecycle Events](./docs/lifecycle.md) — Widget initialization, mount, and cleanup
- [Storage API](./docs/storage.md) — Persistent data storage
- [Slot System](./docs/slots.md) — Where widgets can be mounted
- [Manifest](./docs/manifest.md) — Kind 30033 event structure
- [Security](./docs/security.md) — Security guidelines
- [Quick Start](./docs/quickstart.md) — Getting started guide

## Common Commands

```bash
pnpm dev              # Start local dev server
pnpm build            # Build all packages
pnpm test             # Run unit tests
pnpm test:coverage    # Run tests with coverage
pnpm e2e              # Run Playwright E2E tests
pnpm verify           # Lint + type-check + test
pnpm manifest:generate # Generate Smart Widget manifest
```

## License

MIT License — see [LICENSE](LICENSE) file for details.
