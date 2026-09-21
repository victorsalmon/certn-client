# Contributing

## Setup

```bash
npm ci
```

Requires Node.js >= 22 (see `.nvmrc`).

## Test

```bash
npm test           # vitest — unit tests, mocked fetch, no network calls
npm run typecheck  # tsc --noEmit
npm run build      # emit dist/ + declarations
npm run lint       # eslint (flat config)
npm run format:check  # prettier --check (use `npm run format` to fix)
npm run lint:md    # markdownlint on docs/ and README.md
```

`npm run test:mutation` runs Stryker; keep an eye on the mutation score when touching verification or normalization logic.

## Pull requests

- Keep PRs small and focused — one concern per PR.
- Add or update tests for every behavior change; all tests must use mocked `fetch`.
- Use obviously synthetic credentials and PII in fixtures — never real keys, emails, or identity data.
- Match the existing code style (strict TypeScript, ESM with `.js` import suffixes).
- Update `README.md` and `CHANGELOG.md` when the public API or behavior changes.
