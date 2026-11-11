# AGENTS.md - ArdentStudio

Guidance for contributors (human or AI) working on ArdentStudio, the Ardent Project Studio
service of the Hive:Magnus suite. It owns Studio projects, templates, team revisions, the
conversation transcript, review records and the project event feed. This repository is public
and Apache-2.0; preserve LICENSE and NOTICE.

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
  denylist, also on commit messages) and `scripts/scan-secrets.sh`.

## Studio rules

- **Agents only through Magnus.** Every agent read and action goes through the Magnus control
  API (`src/clients/magnus.ts`) with ArdentStudio's Oathweave service identity. Never call a
  fleet node, a Magnus node agent or an Ardent management API directly, and never store an
  Ardent or node token. New agents are created only by Magnus's New Agent capability.
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
