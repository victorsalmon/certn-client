# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-08-21

### Added

- TypeScript client for the Certn Centric screening API.
- Case ordering with allow-listed screening profiles (`identity`, `credit`, `risk`).
- Report fetch with normalized outcomes and PII-stripped `reportJsonb`.
- PDF generation and polling with exponential backoff.
- Case cancellation.
- Webhook verification using HMAC-SHA256 over the raw body (`X-Signature` header).
- `createCertnConfigFromEnv` helper for sandbox/production configuration from environment variables.
- ESM build with TypeScript declarations and subpath export for `profiles`.
