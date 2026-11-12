# Oathweave

ArdentStudio uses Oathweave in two directions: people sign in to it, and it signs in to Magnus and
HiveMem as itself.

## People (resource tokens, audience `ardentstudio`)

Configure the browser issuer with all three HTTPS endpoints:

```
OATHWEAVE_ISSUER=https://identity.example.com
OATHWEAVE_JWKS_URL=https://identity.example.com/.well-known/jwks.json
OATHWEAVE_USERINFO_URL=https://identity.example.com/api/v1/oauth/userinfo
```

A token is accepted only when it is RS256-signed by the JWKS, has exactly this issuer and the
audience `ardentstudio`, lives at most fifteen minutes, is a `USER` actor with a session, and its
session is still active at userinfo (checked online, cached for ten seconds). Token times are
checked without clock skew. Open streams re-check every five seconds and close at token expiry.
Failure is closed: an unreachable JWKS or userinfo also answers `401 UNAUTHENTICATED`.
Verification uses the suite's shared verifier from `@hivemagnus/hive-common`, and the test suite
runs its Oathweave conformance vectors.

`ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON` is a reviewed JSON array of explicit account links:

```json
[
  {"issuer": "https://identity.example.com", "subject": "example-subject", "localUserId": "operator"},
  {"issuer": "https://identity.example.com", "subject": "example-viewer", "localUserId": "viewer",
   "displayName": "Viewer", "permissions": ["ardentstudio:projects:read", "ardentstudio:templates:read"]}
]
```

- Every link's `issuer` must equal `OATHWEAVE_ISSUER`; links are unique per issuer and subject.
- `localUserId` is the Studio user recorded on records and audit rows. It may not be `system` or
  start with `service:`.
- `permissions` is an optional ceiling. The token's permissions grant only within it; without it,
  any Studio permission the token carries applies. Roles and email addresses are never consulted.
- Unlinked subjects are refused with `403 NO_ACCOUNT_LINK`.

Permissions: `ardentstudio:projects:read`, `ardentstudio:projects:write`,
`ardentstudio:templates:read`, `ardentstudio:templates:write`, `ardentstudio:review:write`,
`ardentstudio:agents:admin`. Give HiveXUI a browser client (for example `hivexui-ardentstudio`)
whose policy can request them for the audience `ardentstudio`.

## ArdentStudio's service identity (client_credentials)

Oathweave binds each machine client to one audience, so ArdentStudio uses two:

| Client (example) | Audience | Used for |
|---|---|---|
| `ardentstudio-magnus` | `magnus` | Every agent read and action through the Magnus control API |
| `ardentstudio-hivemem` | `hivemem` | Project workspaces and knowledge source sync |

Declare them in Oathweave's `IAM_MACHINE_CLIENT_POLICIES` with their audience and permissions, and
give ArdentStudio their secrets (`ARDENT_STUDIO_MAGNUS_CLIENT_SECRET`,
`ARDENT_STUDIO_HIVEMEM_CLIENT_SECRET`) and the token endpoint
(`ARDENT_STUDIO_OATHWEAVE_TOKEN_URL`). ArdentStudio fetches a short-lived token on first use and
replaces it before it expires; nothing renews it by hand.

- **Magnus** links the client to a Magnus service user that may use the Studio routes. For work a
  person asked for, ArdentStudio forwards the person's Oathweave subject in `x-acting-subject`;
  Magnus verifies it and records both in its audit. New Agent, reading an agent's configuration
  and the agent changes Apply makes (`identity-save`, `skill-set`, `config-save`) run only when that
  person is a linked Magnus ADMIN; `config-save` may change only Magnus's allowed settings (backend,
  model settings, enabled skills, artifact size). The service identity cannot restart a profile.
- **HiveMem** links the client in `HIVEMEM_OATHWEAVE_SERVICES_JSON` with the issuer that signs
  client-credentials tokens, a `localId`, and the scopes `workspaces:write` and `memories:write`.
