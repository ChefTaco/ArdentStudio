# Contributing to ArdentStudio

Bug reports, documentation fixes and pull requests are welcome.

## Getting set up

```bash
npm ci                # Node.js 24.22.1+ or 26.13.0+
npm run hooks:install # privacy and secret checks on commit and push
npm run build
```

## Before opening a pull request

Run the same gates that CI runs:

```bash
npm run verify
```

- Keep TypeScript strict and follow the style of the surrounding code. See [AGENTS.md](AGENTS.md).
- Add or update tests for behaviour changes; security fixes need a regression test.
- If you change a route or a schema in `src/shared/browser.ts`, run `npm run contracts:write`
  and commit `docs/openapi-browser.json`.
- Schema changes are new numbered migrations in `src/db/migrations.ts`; never edit a released one.
- Never commit `.env` files, keys, databases, data volumes or details of private infrastructure.
  The git hooks in `.githooks/` enforce this.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
`chore:` and so on), with an optional scope such as `fix(team): ...`.

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
