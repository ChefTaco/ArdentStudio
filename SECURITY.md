# Security Policy

## Supported versions

Security fixes are released for the latest `0.x` version of `@hivemagnus/ardent-studio`.

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Report them privately through
[GitHub private vulnerability reporting](https://github.com/ChefTaco/ArdentStudio/security/advisories/new).
Please include:

- the affected version or commit
- steps to reproduce, or a proof of concept
- the impact you expect

You should get an acknowledgement within a few days. Once a fix is available, a GitHub security
advisory will credit you unless you ask not to be named.

## Hardening notes for operators

- Serve ArdentStudio behind the suite reverse proxy over HTTPS. It listens on loopback by default.
- Keep the machine-client secrets and the ChatterMost webhook URL in a private env file readable
  only by the service account.
- Link each person explicitly in `ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON`; unlinked identities
  are refused even with a valid token.
- Back up the whole data volume (SQLite database and blobs) together; see `docs/OPERATIONS.md`.
