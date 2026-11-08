# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Service foundation: Hono API under `/api/ardentstudio/v1`, fail-fast configuration,
  Oathweave resource-token verification (audience `ardentstudio`) with explicit identity
  links, append-only audit and `x-idempotency-key` on every mutation.
- SQLite schema (WAL, numbered additive migrations) for every Studio record, prefixed
  ULID identifiers and a per-project event feed with seq assigned in the inserting transaction.
- Content-addressed blob store with temp-file, fsync, rename and SHA-256 verification.
- Clients for Magnus (service identity, acting subject, released Ardent routes and the
  planned Studio routes), HiveMem (project workspaces and knowledge source sync) and an
  optional ChatterMost incoming webhook.
- Routes for health, projects, files with HiveMem knowledge sync, versioned templates with
  the Research Team, Development Team, Adventure Studio and Deliberation Panel seeds, team assignment
  (draft, validate, publish, apply template, save as template), agents through Magnus, and
  the project event stream (SSE with replay, heartbeat and reset).
- Zod browser contract (`src/shared/browser.ts`) and the generated
  `docs/openapi-browser.json`, with a staleness check.
- Conversation room: team, direct and discussion conversations, the canonical transcript with a
  per-project message seq, decisions, the Studio task mirror (pause, resume, cancel, reassign) and
  room layout revisions.
- The conductor: dispatch by Team, Coordinator, role or @mention with ordering groups, Ardent
  missions through Magnus (task submission with a composed prompt on older agents), one task
  stream per active task with cursor resume and polling fallback, live `message.delta` relay,
  idempotent final messages, hand-off enforcement on team edges, clarifications that continue the
  same session, decision proposals, discussion rounds with a coordinator summary, presence
  probing and activity from journal events, and restart safety.
- Deliverable Review: an artifact importer that streams registered files from Magnus into the
  blob store, verifies their SHA-256 and records superseding deliverable revisions; deliverables,
  anchored comments (text, DOCX, PDF, image, whole file), review decisions, final revisions,
  revision requests that send anchored comments to the producer role, and export packages (zip
  with `manifest.json`). DOCX conversion routes are stored per file or revision and answer 501
  until the canvas Word codec package is available.
- Container image (non-root, no package managers at runtime, `/data` volume), CI and a
  publish workflow for npm trusted publishing and GHCR.
