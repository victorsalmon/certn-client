# Supply chain

Docs-only note: this file describes dependency provenance, SBOM/release
hygiene, and secure-consumption guidance for `certn-client`. It changes no
runtime source. Every claim below is reproducible from the repository with
the command shown next to it.

## Dependency provenance

- **Zero runtime dependencies.** `package.json` declares no `dependencies`
  field — only `devDependencies` (`@stryker-mutator/core`,
  `@stryker-mutator/vitest-runner`, `@types/node`, `typescript`, `vitest`).
  Reproduce: `node -e "console.log(Object.keys(require('./package.json').dependencies || {}).length)"`
  prints `0`.
- **Pinned, committed lockfile.** `package-lock.json` is committed at the
  repo root, so `npm ci` installs the exact reviewed tree. Reproduce:
  `Test-Path package-lock.json` (PowerShell) or `test -f package-lock.json`
  (POSIX). CI installs with `npm ci`, never a floating `npm install`
  (see `.github/workflows/ci.yml`).
- **Node toolchain is pinned.** `engines` requires `node >= 22` and `.nvmrc`
  contains `22`; CI's `setup-node` uses `node-version-file: .nvmrc`.
  Reproduce: `Get-Content .nvmrc` and
  `node -e "console.log(require('./package.json').engines.node)"`.
- **No extra HTTP layer.** The client uses the Node ≥ 22 global `fetch`
  (see `README.md` Install); there is no `axios`/`node-fetch`/`got`
  dependency to audit or keep current.
- **Package identity.** `name: @clocklobster/certn-client`, `version: 1.0.0`,
  `license: MIT`, `repository: https://github.com/victorsalmon/certn-client.git`.
  Reproduce: `node -e "const p=require('./package.json'); console.log(p.name, p.version, p.license)"`.

## SBOM and release hygiene

- **SBOM on demand from the lockfile.** No prebuilt SBOM is checked in; any
  consumer or releaser can generate one deterministically from the committed
  lockfile, e.g. `npm sbom --sbom-format cyclonedx` (npm ≥ 9) or
  `npm ls --omit=dev` for the production tree (which is empty — see above).
- **Minimal published surface.** `package.json` sets `"files": ["dist"]`, so
  only the compiled `dist/` output ships; `src/`, `test/`, and config never
  publish. `main`/`exports` point at `dist/index.js` (+ `dist/profiles.js`)
  with matching `.d.ts` declarations.
- **Versioning discipline.** `CHANGELOG.md` follows Keep a Changelog and the
  project adheres to Semantic Versioning; current version is `1.0.0`
  (see `package.json`). The `[Unreleased]` section records pending changes
  (timeouts/retry, CI audit gate, `engines`, data-retention docs).
- **CI release gate (`.github/workflows/ci.yml`).** Every push/PR to `main`
  runs, in order: `npm ci` → prod-tree audit
  (`npm audit --omit=dev --audit-level=high`) → full-tree audit
  (`npm audit --audit-level=high`) → `npm run typecheck` → `npm run build`
  → `npm test`. The audit steps fail on HIGH-or-worse advisories.
- **Known advisory state.** The production tree is clean. Remaining
  MODERATE `qs` advisories arrive dev-only via
  `typed-rest-client@2.3.1` ← `@stryker-mutator/core` (mutation testing, not
  shipped); owner and upgrade trigger are recorded in `README.md` Security.
  Re-run either audit command locally and fix with `npm audit fix`.
- **Test evidence.** The suite is 97 offline tests (mocked `fetch`, no
  network, no credentials). Reproduce the count:
  `Select-String -Path test/*.ts -Pattern '^\s*(it|test)\(' -AllMatches`
  (or `grep -cE '^\s*(it|test)\(' test/*.test.ts`), then `npm test`.

## Secure consumption

- **Pin the version.** Depend on an exact version
  (`npm install @clocklobster/certn-client@1.0.0 --save-exact`) and keep the
  consumer's own lockfile committed so upgrades are deliberate diffs.
- **Verify integrity.** Confirm the installed tree matches the published
  manifest (`npm ls @clocklobster/certn-client`, `npm audit --omit=dev`)
  and re-run the two CI audit commands above after every dependency change.
- **Configure from the environment, never from committed secrets.**
  `createCertnConfigFromEnv()` reads `CERTN_API_KEY` / `CERTN_WEBHOOK_SECRET`;
  `.gitignore` excludes `.env` / `.env.*` (except the synthetic
  `.env.example`). Never commit a live `CERTN_API_KEY` or webhook secret —
  see `SECURITY.md`.
- **Least privilege.** The API key travels only as an `Authorization: Api-Key`
  header to the configured Certn `baseUrl`; the webhook secret is used only
  for `X-Signature` HMAC verification and is never sent to the API.
  Rotate either credential immediately if it appears in logs, error output,
  or Git history.
- **Treat provider timestamps and counts honestly.** `evictionCount` is
  always `null` ("not measured", never "zero evictions") and `completedAt`
  is `string | null` (provider `modified`/`created`, or `null`); see
  `README.md` Data retention. Persist only the PII-stripped `reportJsonb`
  and delete reports when the business purpose ends.
- **Report supply-chain issues privately.** Do not open a public issue for a
  suspected vulnerability (dependency confusion, tampered tarball, leaked
  credential); use the private advisory channel per `SECURITY.md` with
  reproduction steps, affected versions, and impact — no live credentials
  or customer data.
