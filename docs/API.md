# certn-client API reference

Public surface of `@clocklobster/certn-client` — every export of `src/index.ts`
with its signature and one-line semantics. Auth is
`Authorization: Api-Key <key>` against the Certn Centric paths under
`/api/public/cases/*` only.

## Client factory

- `createCertnClient(config: CertnClientConfig): CertnClient` — construct a
  product-neutral Certn Centric screening client (same pattern as vopay-client).
- `class CertnClient` — stateful client bound to one `CertnClientConfig`;
  `baseUrl` trailing slashes are normalized at construction.

## `CertnClient` methods

- `invite(applicantEmail: string, profileName?: string, _applicantName?: string): Promise<ScreeningInvitation>` — order a screening case (`POST /api/public/cases/order/`) and return the invite link; `profileName` (allow-listed) overrides `config.profileName`; `_applicantName` is intentionally ignored (the public API takes no applicant name).
- `fetchReport(caseId: string): Promise<ScreeningReport>` — fetch and normalize a case report (`GET /api/public/cases/{id}`) with PII stripped.
- `fetchPdf(caseId: string): Promise<Buffer>` — generate a report PDF (`POST /api/public/cases/{id}/generate-report/`), poll the report-file endpoint until `COMPLETE`, then download the signed `pdf_url` bytes.
- `cancelCase(caseId: string): Promise<void>` — cancel a case (`POST /api/public/cases/{id}/cancel/`).
- `parseWebhook(payload: unknown, headers: Record<string, string>, rawBody?: string): Promise<WebhookResult>` — verify the `X-Signature` HMAC over the raw body, then map the event (`CASE_REPORT_READY`, `CASE_STATUS_CHANGED`, `CANCELLED`, action-required, missing `object_id`) into a normalized result; fetches the report on completion.
- `verifyWebhook(signature: string | undefined, rawBody: string): boolean` — verify a webhook signature against the configured secret without parsing a payload.

## Config (`src/config.ts`)

- `createCertnConfigFromEnv(env?: NodeJS.ProcessEnv): CertnClientConfig` — build config from `CERTN_API_KEY` + `CERTN_WEBHOOK_SECRET` (both required, throws when missing), `CERTN_BASE_URL` (else sandbox/production by `CERTN_ENVIRONMENT`), `CERTN_PROFILE` (defaults to `identity`), `CERTN_GROUP`, `CERTN_TAGS` (JSON array, fail-safe), `CERTN_APPLICANT_LANGUAGE`.
- `CERTN_SANDBOX_BASE_URL: string` — `https://api.sandbox.certn.co`.
- `CERTN_PRODUCTION_BASE_URL: string` — `https://api.ca.certn.co`.
- `DEFAULT_REQUEST_TIMEOUT_MS = 15_000` — default per-attempt timeout for Certn API requests, overridable via `config.requestTimeoutMs`.
- `DEFAULT_PDF_DOWNLOAD_TIMEOUT_MS = 30_000` — default timeout for the signed PDF download, overridable via `config.pdfDownloadTimeoutMs`.
- `DEFAULT_RETRY_DELAY_MS = 500` — default delay before the single retry on HTTP 429/5xx, overridable via `config.retryDelayMs`.
- `interface CertnClientConfig` — `{ baseUrl, apiKey, webhookSecret, profileName?, group?, tags?, applicantLanguage?, requestTimeoutMs?, pdfDownloadTimeoutMs?, retryDelayMs? }`.

## Profiles (`src/profiles.ts`)

- `SCREENING_PROFILES: readonly ScreeningProfile[]` — allow-listed versioned profiles (`identity`, `credit`, `risk`) with current Certn check identifiers.
- `getScreeningProfile(name: string): ScreeningProfile` — resolve a profile by name; throws on unknown/legacy names.
- `isScreeningProfile(name: string): boolean` — true for allow-listed profile names (case-sensitive).
- `DEFAULT_PROFILE_NAME = 'identity'` — profile used when the caller specifies none.
- `interface ScreeningProfile` — `{ name, version, checkTypesWithArguments, label }`.

## Types and errors (`src/types.ts`)

- `interface ScreeningReport` — `{ creditScore: number | null, evictionCount: number | null (always null — not measured), idVerified: boolean | null, reportJsonb: Record<string, unknown> (PII-stripped), completedAt: string | null }`.
- `type WebhookStatus = 'completed' | 'in_progress' | 'error'` — normalized webhook outcome.
- `interface WebhookResult` — `{ applicationId, status, report?, eventId?, actionRequired? }`; persist `eventId` as a `(provider, event_id)` receipt so retries/duplicates are no-ops.
- `interface ScreeningInvitation` — `{ secureLink, purchaseToken }` (`purchaseToken` is the Certn case id for `fetchReport`/`fetchPdf`/`cancelCase`).
- `class CertnWebhookSignatureError extends Error` — thrown on missing/invalid webhook signatures; carries `statusCode = 401`.

## Webhook helpers (`src/util.ts`)

- `safeEqual(a: string, b: string): boolean` — constant-time string comparison (lengths differ → false).
- `verifySecret(provided: string | undefined, expected: string): boolean` — true for a non-empty constant-time match; fails closed on empty input or empty expected secret.

## Polling, timeout, and retry semantics (as implemented)

- `fetchPdf` polls `GET /api/public/cases/report-files/{id}/` on a **fixed 750 ms interval, up to 10 attempts** (`PDF_POLL_INTERVAL_MS = 750`, `MAX_PDF_POLL_ATTEMPTS = 10`) — not exponential backoff. `COMPLETE` + `pdf_url` downloads; `FAILED` throws; no `COMPLETE` within 10 attempts throws a did-not-become-available error.
- Every API attempt aborts after `config.requestTimeoutMs` (default 15 s) via `AbortSignal.timeout`; the PDF download aborts after `config.pdfDownloadTimeoutMs` (default 30 s); aborts surface as `Certn request timed out` errors.
- `invite` and `fetchReport` retry **once** after `config.retryDelayMs` (default 500 ms) on HTTP 429/5xx; other 4xx, timeouts, network errors, and webhook-signature failures never retry.
- `invite` rejects empty/malformed `applicantEmail` before any network call; `invite`/`fetchReport`/`fetchPdf`/`cancelCase` throw on empty/whitespace `caseId` before any network call.
- `completedAt` is `string | null` — provider `modified` (fallback `created`), or `null` when the provider supplies neither; the client never fabricates a timestamp. `evictionCount` is always `null` ("not measured", never "zero evictions").
