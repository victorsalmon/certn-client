# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Enforced HTTPS for the client `baseUrl` at construction: a plaintext
  `http://` base URL now throws (HTTP is allowed only for
  `localhost`/`127.0.0.1`), so the `Api-Key` header can never be sent over an
  unencrypted connection.
- Full-tree `npm audit` is clean (0 vulnerabilities): `fast-uri` HIGH fixed via
  `npm audit fix` (-> 3.1.7) and dev-only `qs` MODERATE chain pinned out via a
  `qs ^6.16.0` override. CI now gates both the prod and full trees on
  HIGH-or-worse.

### Added

- Request resilience: every provider `fetch` aborts after a documented default
  timeout (15 s API via `requestTimeoutMs`, 30 s PDF download via
  `pdfDownloadTimeoutMs`), overridable via client config; `invite`/`fetchReport`
  retry once after a bounded delay (`retryDelayMs`, default 500 ms) on HTTP
  429/5xx with no retry on other 4xx or webhook-signature failures.
- Pre-flight validation: `invite()` rejects empty/malformed `applicantEmail` and
  `fetchReport`/`fetchPdf`/`cancelCase` reject empty/whitespace `caseId` before
  any network call.
- Null-honest report typing: `completedAt` is `string | null` (`null` when the
  provider supplies neither `modified` nor `created`, never fabricated) and
  `evictionCount: null` is documented in code + TSDoc as "not measured by this
  client". README Configuration, Error handling, API reference, and Data
  retention synced; test suite now 105 passing.
- README "Data retention" subsection (persistable artifacts, minimization /
  deletion duties, `evictionCount: null` = not measured, `completedAt`
  non-null fallback semantics) and a dependency-audit note with owner +
  upgrade triggers.
- Storefront polish: truthful README badges (CI status, npm version,
  Node >= 22, 105 passing tests), CI dependency-audit gate
  (`npm audit --omit=dev --audit-level=high`), and `engines` metadata
  (`node >= 22`).
- Base-URL transport-safety tests (HTTPS required; localhost HTTP allowed) —
  suite now 108 passing.

### Changed

- Bumped `@types/node` to `^26.6.2` (latest stable patch/minor); no runtime
  behavior change.
- Corrected `docs/API.md` so its "public surface" claim matches the package
  root: `DEFAULT_REQUEST_TIMEOUT_MS` / `DEFAULT_PDF_DOWNLOAD_TIMEOUT_MS` /
  `DEFAULT_RETRY_DELAY_MS` are module constants (not root exports), and
  `DEFAULT_PROFILE_NAME` exports from the `./profiles` subpath.
- Refreshed the `docs/supply-chain.md` dependency inventory (six
  devDependencies) and documented the TypeScript side-by-side aliases
  (`tsc` = TS7, `tsc6`/TS6 API for Stryker) plus the deliberately deferred
  `vitest` major; linked it from the README dependency-audit section.

### Fixed

- Corrected PDF polling description: `fetchPdf` polls the report-file endpoint
  on a fixed 750 ms interval, up to 10 attempts (not exponential backoff).
- Redacted absolute local worktree paths from the committed
  `reports/salmon-run/` QA-evidence JSON so the public repo carries no
  machine-specific or fleet-lane references.

## [1.0.0] - 2026-08-21

### Added

- TypeScript client for the Certn Centric screening API.
- Case ordering with allow-listed screening profiles (`identity`, `credit`, `risk`).
- Report fetch with normalized outcomes and PII-stripped `reportJsonb`.
- PDF generation and polling on a fixed 750 ms interval, up to 10 attempts.
- Case cancellation.
- Webhook verification using HMAC-SHA256 over the raw body (`X-Signature` header).
- `createCertnConfigFromEnv` helper for sandbox/production configuration from environment variables.
- ESM build with TypeScript declarations and subpath export for `profiles`.
