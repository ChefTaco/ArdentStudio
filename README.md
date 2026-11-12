# Ardent Project Studio (ArdentStudio)

ArdentStudio is the backend of **Ardent Project Studio**, the Hive:Magnus workspace where an
operator gives several [Ardent](https://github.com/ChefTaco/Ardent) agents a shared project, puts
them in a team, watches them work together and reviews what they deliver. The UI is the Studio
module of HiveXUI (`/studio`); this service owns the records behind it.

A project has three areas:

1. **Team Assignment**: roles, relationships and agent bindings, as draft and published revisions,
   started from versioned templates.
2. **Team Conversation Room**: the canonical transcript, live agent replies, tasks, clarifications,
   discussions and decisions, driven by the conductor ([docs/CONDUCTOR.md](docs/CONDUCTOR.md)).
3. **Agent Studio**: agent tuning, previews, development records and **Deliverable Review**
   (verified deliverable revisions, anchored comments, revision requests, decisions and exports).

Version 0.1 covers projects, reference files with HiveMem knowledge sync, templates, team
assignment, agents through Magnus (Agent Studio drafts, streaming previews, apply, development
records and New Agent), the conversation room with its conductor, Deliverable Review and the live
project event stream.

## Requirements

| Dependency | Required | Why |
|---|---|---|
| [Magnus](https://github.com/ChefTaco/magnus) with **at least one Ardent agent** | Yes | All agent access goes through Magnus. Studio never talks to nodes or Ardent directly. |
| [HiveMem](https://github.com/ChefTaco/HiveMem) | Yes | Each project has a HiveMem workspace; reference files are synced into it as knowledge. |
| [Oathweave](https://github.com/ChefTaco/Oathweave) | Yes | Sign-in for people (audience `ardentstudio`) and ArdentStudio's own service identity. |
| ChatterMost | No | Optional one-way announcements through an incoming webhook. |

Node.js 24.22.3+ or 26.13.1+.

## Architecture

```
HiveXUI /studio/*  ── user token (audience ardentstudio) ──▶  ArdentStudio  /api/ardentstudio/v1/*
                                                               SQLite (WAL) + content-addressed blobs
                                                               project event feed (SSE)
                                                                  │ service identity (client_credentials)
                                     ┌────────────────────────────┴───────────────────────────┐
                                     ▼ audience magnus, x-acting-subject                      ▼ audience hivemem
                          Magnus control API /api/v1/ardent/*                    HiveMem /v1/workspaces,
                          ── node agent ──▶ Ardent profile API                   /v1/knowledge/sources/sync
```

- **ArdentStudio owns** projects, templates, team revisions, the transcript, decisions, the Studio
  task mirror, deliverables, review records, exports, drafts, presentation and the event feed.
- **Magnus owns** the fleet, profile lifecycle and all agent access. ArdentStudio calls it with its
  own Oathweave service identity and forwards the acting person's subject in `x-acting-subject`.
- **Ardent owns** execution, sessions, journals, live reply text, artifacts and identity history.
- **HiveMem owns** project knowledge (one workspace per project) and agent memory.

Studio uses Magnus's Ardent bridge for service identities (sessions, task streams, missions,
pause and resume, New Agent). An agent whose Magnus node agent reports a lower Studio level still
works through plain task submission; see [docs/CONDUCTOR.md](docs/CONDUCTOR.md).

## Quick start

```bash
npm ci
npm run build
cp .env.example .env   # fill in real values privately; never commit them
set -a; . ./.env; set +a
node dist/main.js serve
```

`node dist/main.js env` lists every variable. The service refuses to start, naming each problem,
when a required setting is missing or unsafe.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `ARDENT_STUDIO_DATA` | yes | | Absolute data directory (`studio.sqlite`, `blobs/`). The image uses `/data`. |
| `ARDENT_STUDIO_HOST` | | `127.0.0.1` | Listen address (`0.0.0.0` in the image). |
| `ARDENT_STUDIO_PORT` | | `8097` | Listen port. |
| `ARDENT_STUDIO_MAX_BLOB_BYTES` | | `67108864` | Largest stored file (64 MiB). |
| `ARDENT_STUDIO_EVENT_RETENTION_DAYS` | | `30` | Event replay window; older cursors get `reset`. |
| `ARDENT_STUDIO_LOG_LEVEL` | | `info` | `debug`, `info`, `warn` or `error`. |
| `OATHWEAVE_ISSUER` | yes | | Oathweave browser issuer (HTTPS). |
| `OATHWEAVE_JWKS_URL` | yes | | Oathweave JWKS (HTTPS). |
| `OATHWEAVE_USERINFO_URL` | yes | | Oathweave userinfo (HTTPS), for session revocation. |
| `ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON` | yes | | Explicit account links; see [docs/OATHWEAVE.md](docs/OATHWEAVE.md). |
| `ARDENT_STUDIO_OATHWEAVE_TOKEN_URL` | yes | | Oathweave token endpoint for `client_credentials`. |
| `ARDENT_STUDIO_MAGNUS_URL` | yes | | Magnus control API origin. |
| `ARDENT_STUDIO_MAGNUS_CLIENT_ID` | yes | | Machine client for the audience `magnus`. |
| `ARDENT_STUDIO_MAGNUS_CLIENT_SECRET` | yes (secret) | | Its secret. |
| `ARDENT_STUDIO_MAGNUS_SCOPE` | | `magnus:ardent` | Token scope. Oathweave grants nothing without one. |
| `ARDENT_STUDIO_HIVEMEM_URL` | yes | | HiveMem origin. |
| `ARDENT_STUDIO_HIVEMEM_CLIENT_ID` | yes | | Machine client for the audience `hivemem`. |
| `ARDENT_STUDIO_HIVEMEM_CLIENT_SECRET` | yes (secret) | | Its secret. |
| `ARDENT_STUDIO_HIVEMEM_SCOPE` | | `hivemem:workspaces:write hivemem:memories:write` | Token scope. |
| `ARDENT_STUDIO_CHATTERMOST_WEBHOOK_URL` | (secret) | | Optional incoming-webhook URL for announcements. |
| `ARDENT_STUDIO_ALLOW_PLAINTEXT_SERVICES` | | `false` | Allow `http://` service URLs off loopback (isolated container networks only). |

Service URLs must use HTTPS except on loopback. For a private CA, set `NODE_EXTRA_CA_CERTS`.

## API

All routes live under `/api/ardentstudio/v1` and need an Oathweave bearer token with the listed
permission, except the health routes. Every mutation takes `x-idempotency-key`. See
[docs/API.md](docs/API.md); the machine-readable contract is
[`docs/openapi-browser.json`](docs/openapi-browser.json), generated from the zod contract in
[`src/shared/browser.ts`](src/shared/browser.ts) (also exported as
`@hivemagnus/ardent-studio/browser`).

`GET /api/ardentstudio/v1/audit/export` serves the audit log as suite `HiveAuditRecord` v1
records for a collector such as Cindertrace. It needs the permission `ardentstudio:audit:read`,
which an Oathweave service (client_credentials) token for the audience `ardentstudio` may carry,
or a linked Studio admin (`ardentstudio:agents:admin`). See
[docs/OATHWEAVE.md](docs/OATHWEAVE.md#audit-export).

## Container image

```bash
docker build -t ardent-studio .
docker run --env-file ./studio.env -v ardentstudio-data:/data -p 127.0.0.1:8097:8097 ardent-studio
```

The image runs as `node`, ships no package manager and keeps all state in the `/data` volume.
Back up that volume; see [docs/OPERATIONS.md](docs/OPERATIONS.md).

Each release is published to npm as `@hivemagnus/ardent-studio` (with provenance) and as the
image `ghcr.io/cheftaco/ardent-studio:<version>` for `linux/amd64` and `linux/arm64`. There is no
`latest` tag; the [GitHub release](https://github.com/ChefTaco/ArdentStudio/releases) records
the image digest. In the Hive suite, `hive.sh` installs ArdentStudio as an optional product and
pins the image by digest from a signed release manifest.

## Development

```bash
npm run hooks:install
npm run verify    # privacy and secret scans, typecheck, lint, tests, build, contract check, package check
```

See [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
