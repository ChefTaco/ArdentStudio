# AGENTS.md - ArdentStudio

Guidance for contributors (human or AI) working on ArdentStudio, the Ardent Project Studio
service of the Hive:Magnus suite. It owns Studio projects, templates, team revisions, the
conversation transcript, review records and the project event feed. Its only UI is the fullscreen
Studio module of HiveXUI (`/studio`); it reaches Ardent agents only through Magnus and needs HiveMem
and Oathweave. This repository is public and Apache-2.0; preserve LICENSE and NOTICE.

## Layout

| Path | Contents |
|---|---|
| `src/main.ts`, `src/service.ts`, `src/config.ts` | CLI (`serve`, `env`, `version`), service wiring and the fail-fast environment schema |
| `src/shared/browser.ts` | Browser contract and route table that HiveXUI vendors (see below) |
| `src/server/` | Hono app, router, errors and one file per route area in `routes/` |
| `src/clients/` | Magnus, HiveMem, Oathweave service-token and ChatterMost clients |
| `src/conductor/` | Starts and follows agent turns; derives agent activity ([docs/CONDUCTOR.md](docs/CONDUCTOR.md)) |
| `src/agents/`, `src/team/`, `src/templates/`, `src/review/`, `src/knowledge/` | Agent Studio and New Agent relay, team revisions and proposals, seed templates, Deliverable Review, HiveMem knowledge sync |
| `src/db/`, `src/blobs/`, `src/events/`, `src/audit/` | SQLite store and migrations, content-addressed blobs, event bus, audit export |
| `docs/` | API, conductor, Oathweave and operations guides, and the generated `openapi-browser.json` |
| `test/` | Vitest suites with a fake Magnus (`test/fake-magnus.ts`) |

## Privacy

This repository is public. Never commit secrets, private infrastructure, runtime state, local
notes, or real user data, in code, tests, fixtures, docs, or commit messages:

- No real hostnames, private network domains, IP addresses, usernames, email addresses, or home
  paths. Use placeholders: `example.com` hosts, documentation IP ranges (`192.0.2.0/24`,
  `198.51.100.0/24`, `203.0.113.0/24`), `operator` or `user` accounts, `/home/operator`, and fake
  tokens such as `fixture-token`.
- Never commit `.env`, `.env.*` (except `.env.example`), keys, certificates, databases, data
  volumes, `AGENTS.local.md`, `CLAUDE.local.md`, or `.private-terms`. Read `AGENTS.local.md` when
  present; never copy it into tracked content.
- Install the hooks with `npm run hooks:install` and never bypass them (`--no-verify`). They run
  `scripts/check-private-data.sh` (forbidden paths and the optional, gitignored `.private-terms`
  denylist, also on commit messages), `scripts/scan-secrets.sh` and the pinned Gitleaks
  (`scripts/gitleaks.sh`). Install Gitleaks first with `bash scripts/install-gitleaks.sh`; a
  missing binary fails the hooks (see CONTRIBUTING.md).

## Studio rules

- **Agents only through Magnus.** Every agent read and action goes through the Magnus control
  API (`src/clients/magnus.ts`) with ArdentStudio's Oathweave service identity. Never call a
  fleet node, a Magnus node agent or an Ardent management API directly, and never store an
  Ardent or node token. New agents are created only by Magnus's New Agent capability (in a Hive
  suite, `./hive.sh ardent setup` uses the same workflow for the first assistant).
- **Never fabricate agent activity.** Presence, task state, messages, development records and
  deliverables come from real Ardent records relayed by Magnus. No idle animations driven by
  timers, no placeholder replies, no inferred "working" state, no reasoning or chain-of-thought.
  When Magnus or an agent cannot answer, report that state; do not fill it in.
- **The ArdentStudio transcript is canonical.** Live deltas are a view of a reply; the stored
  final message is authoritative. ChatterMost, when configured, is one-way announcements only.
- **People act, agents request.** Hand-offs, decisions and team changes proposed by an agent are
  enforced or confirmed by Studio rules and people, never applied because a model said so.
- **Templates never carry secrets.** Channel and peer tokens, API keys and credentials are never
  copied into templates, exports or events.
- HiveMem is required for project knowledge. When it is down, keep the files and their real
  sync state and retry; never pretend a file is indexed.

## Ground rules

- Node.js 24.22.3+ or 26.13.1+, ESM, strict TypeScript (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`). Match the style of the file you edit.
- Validate every external input with Zod 4 before use: configuration, HTTP bodies and queries,
  and every response from Magnus, HiveMem and Oathweave.
- Secrets live in the environment and are never logged, echoed or returned. `src/config.ts`
  fails fast on missing or unsafe settings and has no personal defaults.
- Every mutation takes `x-idempotency-key`, runs in one transaction with its audit row and its
  project events, and publishes events only after commit.
- The audit table is append-only. Template versions and published team revisions are immutable.

## Magnus and Ardent versions

Studio follows Ardent through Magnus. Routes, action bodies and answers come from
`@hivemagnus/magnus-contracts/ardent-service`. Every Ardent release is followed by a Magnus release
that moves Magnus's Ardent pin, regenerates its Ardent contract and updates the node agent. When
Studio starts using a new Ardent capability, bump `@hivemagnus/magnus-contracts` to the Magnus
release that exposes it and keep the fallback for older agents: features are gated on the node
agent's Studio level and the agent's Ardent version (see [docs/CONDUCTOR.md](docs/CONDUCTOR.md)), and
a Magnus without an action answers `MAGNUS_UPGRADE_REQUIRED`.

## Storage

- SQLite (WAL) plus a content-addressed blob directory, both in the data directory, are one
  backup unit. Schema changes are new numbered migrations in `src/db/migrations.ts`; a released
  migration is never edited (its checksum is verified on start). Keep changes additive.
- Blobs are written to a temp file, fsynced, renamed and re-hashed before they are recorded.
- Event `seq` is per project and assigned in the inserting transaction.

## Browser contract

`src/shared/browser.ts` is the public contract HiveXUI vendors. It imports only `zod`. Routes are
registered from its route table, so permissions and idempotency rules come from one place. When a
route or schema changes, run `npm run contracts:write` and commit `docs/openapi-browser.json`;
`npm run check:contracts` fails when it is stale. Response changes are additive.

## Tests and gates

Add or update tests with every behaviour change; security-relevant fixes need a regression test.
Tests use loopback fixtures, `example.com` hosts and fake tokens only. Before sending a change,
run:

```bash
npm run verify   # privacy tests, secret and private-data scans, typecheck, lint, test, build, contracts, pack
```

## Commits and releases

Use [Conventional Commits](https://www.conventionalcommits.org/). Never overwrite published
versions or release tags. Releases publish from a `vX.Y.Z` tag through
`.github/workflows/publish.yml`, which waits for approval on the `npm-publish` environment,
authenticates with npm trusted publishing and pushes the container image to GHCR.
