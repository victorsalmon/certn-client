# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Request resilience: per-attempt API timeout (`requestTimeoutMs`, default
  15 s), signed-PDF-download timeout (`pdfDownloadTimeoutMs`, default 30 s),
  and a single retry (after `retryDelayMs`, default 500 ms) on HTTP 429/5xx
  for `invite`/`fetchReport`. `invite` validates `applicantEmail` and
  `fetchReport`/`fetchPdf`/`cancelCase` validate `caseId` before any network
  call.
- CI dependency-audit step failing on HIGH-or-worse advisories in both the
  prod and full trees (`npm audit --omit=dev --audit-level=high`,
  `npm audit --audit-level=high`).
- `engines: node >= 22` (matches `.nvmrc`); README "Data retention"
  subsection documenting `reportJsonb`/PDF persistence duties,
  `evictionCount: null` ("not measured"), and `completedAt` nullability.

### Changed

- `ScreeningReport.completedAt` is now `string | null`: `null` when the
  provider supplies neither `modified` nor `created` (no fabricated timestamp).
- Corrected polling description: `fetchPdf` uses a fixed 750 ms interval
  (up to 10 attempts), not exponential backoff.
- Dev-dependency audit: `npm audit fix` cleared the HIGH advisory
  (`fast-uri`); two remaining MODERATE `qs` advisories (dev-only, via
  `@stryker-mutator/core` → `typed-rest-client`) are recorded in the README
  with owner and upgrade trigger.

## [1.0.0] - 2026-08-21

### Added

- TypeScript client for the Certn Centric screening API.
- Case ordering with allow-listed screening profiles (`identity`, `credit`, `risk`).
- Report fetch with normalized outcomes and PII-stripped `reportJsonb`.
- PDF generation and polling on a fixed 750 ms interval (up to 10 attempts).
- Case cancellation.
- Webhook verification using HMAC-SHA256 over the raw body (`X-Signature` header).
- `createCertnConfigFromEnv` helper for sandbox/production configuration from environment variables.
- ESM build with TypeScript declarations and subpath export for `profiles`.
