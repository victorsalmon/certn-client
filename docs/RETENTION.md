# certn-client data-retention guidance

Consumer duties for PII and report data held through
`@clocklobster/certn-client`. Consistent with the README
[PII stripping](../README.md#pii-stripping) and
[Data retention](../README.md#data-retention) sections — where this file and
the README disagree, the README controls and this file must be updated.

## What the client returns

- `fetchReport` returns a `ScreeningReport` whose `reportJsonb` contains
  **only** normalized outcomes and check metadata (`id`, `short_id`, `created`,
  `overall_status`, `overall_score`, and per-check `id`, `short_id`, `type`,
  `status`, `score`, `sub_score`, `adjudication_score`,
  `adjudication_sub_score`).
- `input_claims`, `output_claims`, email addresses, and identity document
  numbers are **never** included — `reportJsonb` is safe to persist without
  additional PII filtering.
- `fetchPdf` returns the generated report PDF bytes for the case.

## What consumers may persist

- The PII-stripped `reportJsonb` and the downloaded PDF bytes.
- The webhook `eventId` as a `(provider, event_id)` receipt so webhook retries
  and out-of-order duplicates are no-ops.
- Only the report fields and statuses the tenancy decision actually needs.

## Minimization and deletion duties

- Minimize what is kept: store only the reports and statuses the tenancy
  decision needs — never raw applicant claims, emails, or identity documents
  (the client never supplies them; do not re-introduce them from your own
  inputs).
- Delete persisted reports and PDFs when the business purpose ends or the
  applicant requests deletion, per applicable privacy law.
- Never log `input_claims`, `output_claims`, email addresses, identity
  documents, the `apiKey` (transit-only `Authorization` header), or the
  `webhookSecret`.

## Field semantics for retention decisions

- `evictionCount` is always `null` — eviction outcomes are **not measured** by
  this client. `null` means "not measured", never "zero evictions"; do not
  treat it as evidence of a clean record.
- `completedAt` is `string | null` — the provider `modified` timestamp
  (fallback: `created`), or `null` when the provider supplies neither. The
  client never fabricates a timestamp, so `null` means "provider gave no
  timestamp", not "just completed".
