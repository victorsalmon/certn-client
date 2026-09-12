# certn-client

[![CI](https://github.com/victorsalmon/certn-client/actions/workflows/ci.yml/badge.svg)](https://github.com/victorsalmon/certn-client/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@clocklobster/certn-client.svg)](https://www.npmjs.com/package/@clocklobster/certn-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.x-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-green.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-105%20passing-brightgreen.svg)](#testing)

A product-neutral TypeScript client for the [Certn Centric](https://certn.co) screening API —
case ordering, report fetch, PDF retrieval, and X-Signature webhook verification.

> **Reference implementation.** This client is a product-neutral, standalone version of the
> Certn Centric integration pattern. It was last validated against the Certn Centric sandbox
> docs as of 2026-08-21, but **re-fetch the [live Certn docs](https://docs.certn.co)**
> before relying on endpoint specifics in production. Pull requests are welcome.

---

## Table of contents

- [Overview](#overview)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Auth model](#auth-model)
- [API reference](#api-reference)
  - [`createCertnClient(config)`](#createcertnclientconfig)
  - [`createCertnConfigFromEnv(env?)`](#createcertnconfigfromenvenv)
  - [Order an invite — `invite(email, profileName?)`](#order-an-invite--inviteemail-profilename)
  - [Fetch a report — `fetchReport(caseId)`](#fetch-a-report--fetchreportcaseid)
  - [Fetch the PDF — `fetchPdf(caseId)`](#fetch-the-pdf--fetchpdfcaseid)
  - [Cancel a case — `cancelCase(caseId)`](#cancel-a-case--cancelcasecaseid)
  - [Verify a webhook — `parseWebhook(payload, headers, rawBody?)`](#verify-a-webhook--parsewebhookpayload-headers-rawbody)
  - [Screening profiles](#screening-profiles)
- [Error handling](#error-handling)
- [Webhooks](#webhooks)
- [PII stripping](#pii-stripping)
- [Data retention](#data-retention)
- [Testing](#testing)
- [Development](#development)
- [Project layout](#project-layout)
- [Certn endpoint reference](#certn-endpoint-reference)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

Certn (Centric) is a Canadian background-check API that lets property managers
order identity verification, credit reports, and criminal record checks for
applicants. This client wraps the core case lifecycle behind a small, typed,
product-neutral surface so a consuming application can:

- **Order a screening case** and get an invite link to send to the applicant
- **Fetch a normalized report** (credit score, identity verification, check metadata)
- **Generate + download a PDF report** (polls the report-file endpoint until COMPLETE)
- **Cancel a case**
- **Verify webhook callbacks** (HMAC-SHA256 over the raw body, `X-Signature` header)

The client targets the **current Certn Centric API only** — `Authorization: Api-Key`,
`/api/public/cases/*` endpoints. The retired `/token/`, `/api/v1/pm/`,
`/api/v1/users/`, and Bearer-token surfaces are not used.

## Features

- **Typed surface** — `ScreeningReport`, `WebhookResult`, `ScreeningInvitation` types
- **Allow-listed profiles** — `identity`, `credit`, `risk` (versioned check identifiers; the
  retired `softcheck` label is rejected)
- **Webhook signature verification** — constant-time HMAC-SHA256 comparison, hex or base64,
  with optional `sha256=` prefix; fails closed on empty secrets
- **PII stripping** — `fetchReport` returns only normalized outcomes + check metadata;
  `input_claims`, `output_claims`, email addresses, and identity documents are never persisted
- **Request resilience** — every provider `fetch` aborts after a documented default
  timeout (15 s API, 30 s PDF download), overridable via `requestTimeoutMs` /
  `pdfDownloadTimeoutMs`
- **Bounded retry** — `invite` / `fetchReport` retry once after a bounded delay
  (default 500 ms via `retryDelayMs`) on HTTP 429/5xx; other 4xx and
  webhook-signature failures never retry
- **Pre-flight validation** — `invite()` rejects empty/malformed `applicantEmail`
  and `fetchReport` / `fetchPdf` / `cancelCase` reject empty/whitespace `caseId`
  before any network call
- **Null-honest timestamps** — `completedAt` is `string | null` (never fabricated);
  `evictionCount` is always `null` meaning "not measured by this client"
- **Polling with fixed interval** — `fetchPdf` polls the report-file endpoint (750ms, up to 10 attempts)
- **Product-neutral** — no application-specific coupling; consuming apps map the results into
  their own domain models

## Install

```bash
npm install @clocklobster/certn-client
# or
pnpm add @clocklobster/certn-client
```

The package ships ESM + TypeScript declarations. Node.js ≥ 22 (see `.nvmrc`; uses global `fetch`).

## Quick start

```ts
import { createCertnClient, createCertnConfigFromEnv } from '@clocklobster/certn-client';

const client = createCertnClient(createCertnConfigFromEnv());

// Order a screening case for an applicant.
const { purchaseToken, secureLink } = await client.invite('jane@example.com', 'credit');
// → send `secureLink` to the applicant; store `purchaseToken` (the Certn case id)

// Later, after a CASE_REPORT_READY webhook:
const report = await client.fetchReport(purchaseToken);
console.log(report.creditScore, report.idVerified);

// Download the PDF bytes:
const pdf = await client.fetchPdf(purchaseToken);
```

## Configuration

```ts
import { createCertnClient, type CertnClientConfig } from '@clocklobster/certn-client';

const config: CertnClientConfig = {
  baseUrl: 'https://api.sandbox.certn.co', // or https://api.ca.certn.co
  apiKey: 'your-api-key',
  webhookSecret: 'your-webhook-hmac-secret',
  profileName: 'identity',           // optional; default 'identity'
  group: 'your-case-group',          // optional
  tags: ['tenant-screening'],        // optional
  applicantLanguage: 'en-CA',        // optional
  requestTimeoutMs: 15_000,          // optional; default 15 s for API requests
  pdfDownloadTimeoutMs: 30_000,      // optional; default 30 s for PDF download
  retryDelayMs: 500,                 // optional; default 500 ms single 429/5xx retry delay
};

const client = createCertnClient(config);
```

### From environment variables

```ts
import { createCertnConfigFromEnv } from '@clocklobster/certn-client';

const config = createCertnConfigFromEnv();
```

| Var | Required | Default | Notes |
| :--- | :--- | :--- | :--- |
| `CERTN_API_KEY` | yes | — | `Authorization: Api-Key <key>` |
| `CERTN_WEBHOOK_SECRET` | yes | — | HMAC-SHA256 secret for `X-Signature` verification |
| `CERTN_BASE_URL` | no | sandbox/production by `CERTN_ENVIRONMENT` | Override the API base URL |
| `CERTN_ENVIRONMENT` | no | sandbox | `production` → `https://api.ca.certn.co` |
| `CERTN_PROFILE` | no | `identity` | Allow-listed profile name |
| `CERTN_GROUP` | no | — | Optional case group |
| `CERTN_TAGS` | no | `[]` | JSON array of strings |
| `CERTN_APPLICANT_LANGUAGE` | no | — | e.g. `en-CA`, `fr-CA` |

## Auth model

The client uses `Authorization: Api-Key <key>` for every API call. The
`webhookSecret` is used **only** for verifying the `X-Signature` HMAC on
webhook callbacks — it is never sent to the Certn API.

## API reference

### `createCertnClient(config)`

Factory that returns a `CertnClient` instance.

### `createCertnConfigFromEnv(env?)`

Builds a `CertnClientConfig` from `process.env` (or a passed env object). Throws
on missing required values.

### Order an invite — `invite(email, profileName?)`

```ts
const { purchaseToken, secureLink } = await client.invite('jane@example.com', 'credit');
```

Orders a Certn case via `POST /api/public/cases/order/`. `profileName` overrides
the configured `profileName` and must be in the allow-list (`identity`, `credit`,
`risk`). Returns the Certn case id (`purchaseToken`) and the applicant-facing
invite link (`secureLink`).

Throws before any network call on an empty/malformed `applicantEmail`.
Retries once after `retryDelayMs` on HTTP 429/5xx; other 4xx fail fast.
Every attempt aborts after `requestTimeoutMs` (default 15 s).

### Fetch a report — `fetchReport(caseId)`

```ts
const report = await client.fetchReport('case-123');
```

Fetches the case via `GET /api/public/cases/{id}` and normalizes it into a
`ScreeningReport` (credit score, identity verification, check metadata). PII
(input_claims, output_claims, emails, document numbers) is stripped — see
[PII stripping](#pii-stripping).

Throws before any network call on an empty/whitespace `caseId`. Retries once
after `retryDelayMs` on HTTP 429/5xx; other 4xx fail fast. Every attempt aborts
after `requestTimeoutMs` (default 15 s). `completedAt` is `string | null`
(`null` when the provider supplies neither `modified` nor `created` — never
fabricated); `evictionCount` is always `null` meaning "not measured by this
client".

### Fetch the PDF — `fetchPdf(caseId)`

```ts
const pdf = await client.fetchPdf('case-123');
```

Calls `POST /api/public/cases/{id}/generate-report/`, then polls
`GET /api/public/cases/report-files/{id}/` every 750ms (up to 10 attempts) until
`status === 'COMPLETE'`, then downloads the signed `pdf_url`. Returns the PDF
bytes as a `Buffer`.

Throws before any network call on an empty/whitespace `caseId`. API calls abort
after `requestTimeoutMs` (default 15 s); the PDF download aborts after
`pdfDownloadTimeoutMs` (default 30 s).

### Cancel a case — `cancelCase(caseId)`

```ts
await client.cancelCase('case-123');
```

Calls `POST /api/public/cases/{id}/cancel/`.

Throws before any network call on an empty/whitespace `caseId`.

### Verify a webhook — `parseWebhook(payload, headers, rawBody?)`

```ts
const result = await client.parseWebhook(payload, headers, rawBody);
```

Verifies the `X-Signature` HMAC-SHA256 over `rawBody` (the exact request bytes),
then maps the event into a `WebhookResult`:

- `CASE_REPORT_READY` → `completed` (fetches the report)
- `CASE_STATUS_CHANGED` + `case_status === 'COMPLETE'` → `completed` (fetches the report)
- `case_status === 'CANCELLED'` → `error`
- `CLIENT_ACTION_REQUIRED` / `APPLICANT_ACTION_REQUIRED` → `in_progress` with `actionRequired: true`
- Other statuses → `in_progress`
- Missing `object_id` → `{ applicationId: '', status: 'error' }`

Throws `CertnWebhookSignatureError` (with `statusCode: 401`) on missing or invalid
signatures. **Always pass the exact raw request body** — verifying a re-serialized
JSON object will fail if key ordering or whitespace differs.

### Screening profiles

```ts
import { SCREENING_PROFILES, getScreeningProfile, isScreeningProfile } from '@clocklobster/certn-client/profiles';

isScreeningProfile('identity'); // true
isScreeningProfile('softcheck'); // false (retired)
getScreeningProfile('credit').checkTypesWithArguments;
// → { CREDIT_REPORT_1: { ordering_type: 'EXPLICIT_ORDERING', explicit_check_type: ['CANADIAN_CREDIT_REPORT_1'] }, IDENTITY_VERIFICATION_1: {} }
```

The three allow-listed profiles:

| Name | Label | Checks |
| :--- | :--- | :--- |
| `identity` | Identity verification | `IDENTITY_VERIFICATION_1` |
| `credit` | Credit report | `CREDIT_REPORT_1` (explicit → `CANADIAN_CREDIT_REPORT_1`) + `IDENTITY_VERIFICATION_1` |
| `risk` | Risk screening (criminal record) | `CRIMINAL_RECORD_REPORT_1` (explicit → `BASIC_CANADIAN_CRIMINAL_RECORD_REPORT_1`) + `IDENTITY_VERIFICATION_1` |

Check identifiers are versioned (suffix `_1`). When Certn bumps a check identifier,
bump the profile `version` and update `checkTypesWithArguments`. The retired
`softcheck` label is rejected.

## Error handling

- **HTTP errors** — non-2xx responses throw `Error('Certn request failed: <METHOD> <path>: HTTP <status>')`.
- **Timeouts** — every API request aborts after `requestTimeoutMs` (default 15 s)
  and the PDF download after `pdfDownloadTimeoutMs` (default 30 s), throwing
  `Error('Certn request timed out: <label> after <ms>ms')`. Timeouts are never retried.
- **Bounded retry** — `invite` / `fetchReport` retry once after `retryDelayMs`
  (default 500 ms) on HTTP 429/5xx; other 4xx, timeouts, network errors, and
  webhook-signature failures are never retried.
- **Input validation** — `Error('Invalid applicant email: expected a non-empty email address')`
  and `Error('Invalid case id: expected a non-empty case id')` throw before any
  network call.
- **Webhook signature errors** — `CertnWebhookSignatureError` with `statusCode: 401`.
- **Missing fields** — `Error('Certn order response missing id/invite_link')` or
  `Error('Certn report response missing case_report_file_id')`.
- **Report generation failed** — `Error('Certn report generation failed')` when the
  report-file status is `FAILED`.
- **Polling timeout** — `Error('Certn report PDF did not become available before timeout')`
  after 10 attempts.
- **PDF download** — `Error('Certn PDF download failed: HTTP <status>')`.

## Webhooks

Certn sends webhook events to your configured endpoint with an `X-Signature` header
containing the HMAC-SHA256 of the raw request body (hex or base64, optionally
prefixed with `sha256=`). Verify the signature **before** trusting the payload:

```ts
import { createCertnClient, CertnWebhookSignatureError } from '@clocklobster/certn-client';

const client = createCertnClient(config);

app.post('/webhooks/certn', async (req, res) => {
  const rawBody = req.rawBody; // exact bytes — do not re-serialize
  try {
    const result = await client.parseWebhook(JSON.parse(rawBody), req.headers, rawBody);
    if (result.status === 'completed') {
      // persist result.report, mark the application completed
    }
    res.json({ received: true });
  } catch (err) {
    if (err instanceof CertnWebhookSignatureError) {
      res.status(401).json({ error: 'invalid signature' });
    } else {
      res.status(400).json({ error: 'invalid payload' });
    }
  }
});
```

Certn also sends a GET challenge request to verify webhook ownership — echo the
`challenge` query parameter back as plain text within Certn's ten-second deadline.

The `event_id` field is a unique event identifier — persist it as a
`(provider, event_id)` receipt so webhook retries and out-of-order duplicates are
no-ops.

## PII stripping

`fetchReport` returns a `ScreeningReport` with a `reportJsonb` field that contains
**only** normalized outcomes and check metadata:

```ts
{
  id, short_id, created, overall_status, overall_score,
  checks: [{ id, short_id, type, status, score, sub_score, adjudication_score, adjudication_sub_score }]
}
```

`input_claims`, `output_claims`, email addresses, and identity document numbers
are **never** included. Consuming apps can safely persist `reportJsonb` without
additional PII filtering.

## Data retention

Consuming apps may persist only two screening artifacts from this client:

- `reportJsonb` (the PII-stripped normalized report from `fetchReport` — see
  [PII stripping](#pii-stripping));
- the PDF bytes returned by `fetchPdf`.

Minimization and deletion duties stay with the consumer: store these artifacts
only for as long as the tenancy decision requires, restrict access to staff who
need it, and delete them (including backups, where feasible) when the retention
purpose expires or the applicant requests erasure. Never persist upstream
payloads (`input_claims`, `output_claims`, emails, identity documents) — the
client strips them before returning.

Field semantics for retention logic:

- `evictionCount` is always `null`, which means **not measured** — this client
  never sources eviction data. `null` must not be stored, displayed, or
  reasoned about as `0` evictions.
- `completedAt` is `string | null` (never fabricated). It is derived from the
  upstream `modified` timestamp, falling back to `created`, and is `null` when
  the provider supplies neither. Consumers must treat `null` as "completion
  time unknown", not as "just completed".

## Testing

```bash
npm test               # vitest — 105 tests
npm run test:mutation  # stryker mutation testing
```

All 105 tests run offline with mocked `fetch` — no network calls and no live
Certn credentials required. Credentialed runs against the Certn sandbox (real
API key + network) are manual only; they are not part of the suite. The suite
covers:

- Case ordering with each allow-listed profile
- Report normalization (credit score, identity verification, PII stripping)
- PDF generation + polling (COMPLETE, FAILED, PENDING, timeout, download errors)
- Webhook signature verification (hex, base64, `sha256=` prefix, UTF-8 bodies,
  tampered digests, empty secrets)
- Webhook event mapping (CASE_REPORT_READY, CASE_STATUS_CHANGED, CANCELLED,
  action-required, missing object_id)
- Error propagation (4xx fail-fast, 429/5xx single retry, timeout abort,
  email/caseId pre-validation, null-timestamp path)
- Config-from-env (sandbox/production fallback, tags parsing, missing values)

Offline vs credentialed runs: the default `npm test` suite is fully offline
(mocked `fetch`, no `CERTN_*` credentials needed). The suite never hits the
live Certn API; to exercise the client against sandbox/production manually,
set `CERTN_API_KEY` / `CERTN_WEBHOOK_SECRET` (see [Configuration](#configuration))
and drive `examples/quickstart.ts` — no automated credentialed test target is
included.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high  # prod-tree audit (CI gate; fails on HIGH-or-worse; re-run after upgrades or `npm audit fix`)
npm audit --audit-level=high              # full-tree audit incl. dev deps (CI gate; fails on HIGH-or-worse; re-run after upgrades or `npm audit fix`)
```

### Dependency audit

Both audit trees are currently clean (`npm audit` and `npm audit --omit=dev`
report 0 vulnerabilities). Dev-only transitive advisories are pinned out via
the `overrides` field in `package.json`:

| Advisory | Path | Resolution | Owner | Upgrade trigger |
| :--- | :--- | :--- | :--- | :--- |
| `fast-uri` HIGH (GHSA-5jgf-p345-68v8 / GHSA-f65p-4m7j-42xc / GHSA-fph4-wmhf-6fwf / GHSA-jqff-g426-hqxp) | `@stryker-mutator/core` → `ajv` → `fast-uri` (dev-only) | `npm audit fix` → `fast-uri` 3.1.7 | Maintainer | Remove once `ajv`/`@stryker-mutator/core` pull `fast-uri >= 3.1.6` without the fix |
| `qs` MODERATE (GHSA-q8mj-m7cp-5q26 / GHSA-x5fp-wj9c-mxmx / GHSA-4mjr-xmp4-gh2g) | `@stryker-mutator/core` → `typed-rest-client` → `qs` (dev-only) | `overrides: { "qs": "^6.16.0" }` | Maintainer | Drop the override once the `typed-rest-client` range resolves to `qs >= 6.16.0` on a clean install (or `@stryker-mutator/core` moves off `typed-rest-client@2.x`) |

If a future `npm audit` reports a HIGH-or-worse advisory in either tree, fix
with `npm audit fix` (or a targeted upgrade/override as above), then re-run
both audit commands before pushing. Any remaining MODERATE-or-lower advisory
must be recorded in this table with its owner and upgrade trigger.

## Project layout

```
src/
  index.ts       # public surface
  client.ts      # CertnClient class
  config.ts      # CertnClientConfig + createCertnConfigFromEnv
  profiles.ts    # allow-listed screening profiles
  types.ts       # ScreeningReport, WebhookResult, CertnWebhookSignatureError
  util.ts        # constant-time safeEqual / verifySecret
test/
  certn-client.test.ts
```

## Certn endpoint reference

| Method | Path | Purpose |
| :--- | :--- | :--- |
| POST | `/api/public/cases/order/` | Order a screening case |
| GET | `/api/public/cases/{id}` | Fetch case detail |
| POST | `/api/public/cases/{id}/cancel/` | Cancel a case |
| POST | `/api/public/cases/{id}/generate-report/` | Generate a report PDF |
| GET | `/api/public/cases/report-files/{id}/` | Poll report-file status + signed URL |

All paths are relative to the configured `baseUrl` (sandbox or production).

## Security

- **Webhook signature verification** uses constant-time comparison
  (`crypto.timingSafeEqual`) — never `===` on secret strings.
- **Fail closed** — an empty/missing `webhookSecret` never accepts a signature,
  even an empty one.
- **No PII in logs** — the client never logs `input_claims`, `output_claims`,
  email addresses, or identity documents.
- **API key in transit only** — the `apiKey` is sent only as an `Authorization`
  header to the Certn API; it is never logged or persisted by the client.

## Contributing

Pull requests welcome. Correctness fixes (endpoint changes, new check identifiers)
and documentation improvements are appreciated.

## License

[MIT](LICENSE) © 2026 Victor Salmon
