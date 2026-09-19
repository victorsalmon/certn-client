# Decision record — certn-client audit routings (2026-09-19)

Source: Complete Audit of `certn-client` (survey base `main` @ `8805711`,
branch `audit/2026-09-19-certn-client`). The audit landed its safe in-repo
fixes directly (`e6c9e48` HTTPS base URL, `76cb3dd` `@types/node` bump,
`f2a982f` docs alignment, `d3c8141` QA-evidence path redaction). The nine
items below are the decision-gated, non-code, or external remainder. No
runtime source behavior changes here.

## 1. GitHub Actions majors (VER-CN-02)

- **Decision (2026-09-19, owner: maintainer):** bump `actions/checkout@v4` →
  `@v7` and `actions/setup-node@v4` → `@v7` together in
  `.github/workflows/ci.yml`, keeping `node-version-file: .nvmrc`,
  `cache: npm`, the `npm ci` install step, both
  `npm audit --audit-level=high` gates, and the
  `typecheck`/`build`/`test` order intact.
- **Rationale:** stay on a supported major; the step inputs/semantics used
  here (`node-version-file`, `cache`) are unchanged across the bump, and the
  preserved audit/typecheck/build/test steps plus a green CI run on `main`
  prove the migration.

## 2. `vitest` major deferral (VER-CN-03)

- **Decision (2026-09-19, owner: maintainer):** keep `vitest` pinned to
  `^4.1.11`; do not adopt stable major `5.0.1` yet.
- **Rationale:** `@stryker-mutator/vitest-runner` does not support vitest 5
  (mutant substitution silently fails upstream of the runner's tested
  matrix).
- **Revisit trigger:** restore the latest stable `vitest` once the Stryker
  runner advertises vitest 5 support, then re-run `npm test` plus
  `npm run test:mutation`.

## 3. `@types/node` major vs runtime floor (VER-CN-04)

- **Decision (2026-09-19, owner: maintainer):** keep `@types/node` on the
  newest stable line (currently `^26.6.2`) while `engines.node` stays
  `>= 22`.
- **Rationale:** types drift is dev-only and carries no runtime behavior;
  CI pins the runtime to Node 22 via `.nvmrc`, and `typecheck`/`build`/`test`
  prove compatibility. Revisit when `engines` moves to 26.

## 4. `invite()` idempotency (AR-CN-01)

- **Decision (2026-09-19, owner: repo owner):** keep the single 429/5xx retry
  in `src/client.ts` unchanged; callers own de-duplication via the returned
  `purchaseToken`/email lookup until Certn advertises an idempotency key.
- **Rationale:** `invite()` retries `POST /api/public/cases/order/` once on
  HTTP 429/5xx (`src/client.ts:223`); the endpoint is non-idempotent and
  billable, and no provider idempotency-key capability is known, so no code
  guard can be written yet. The documented caller-retry guidance in
  `docs/API.md` (retry semantics + idempotency policy note) is the control.
- **Follow-up:** confirm with Certn whether an idempotency key / client
  request id exists; if one appears, code the guard then.

## 5. Public API surface of the config defaults (AL-CN-01)

- **Decision (2026-09-19, owner: repo owner):** promise the current surface —
  `DEFAULT_REQUEST_TIMEOUT_MS` / `DEFAULT_PDF_DOWNLOAD_TIMEOUT_MS` /
  `DEFAULT_RETRY_DELAY_MS` stay module constants in `src/config.ts` (not root
  exports) and `DEFAULT_PROFILE_NAME` stays on the `./profiles` subpath. No
  new root export in this change.
- **Rationale:** the audit resolved the docs/code drift by correcting
  `docs/API.md`; publishing new root exports would be an additive API
  promise best made deliberately before 1.1.0, not as audit fallout. Stated
  in `docs/API.md` ("Public surface promise").
- **Follow-up:** none open — if a root re-export is ever wanted, print a
  follow-on Code item naming the exact exports instead of editing here.

## 6. Committed QA evidence (SEC-CN-02 follow-on)

- **Decision (2026-09-19, owner: maintainer):** keep tracking the
  path-redacted `reports/salmon-run/` QA-evidence JSON in the public repo.
- **Rationale:** the leak was absolute worktree/fleet-lane paths (fixed in
  `d3c8141`), not the evidence content; tracked evidence gives public proof
  of the offline suite. Future runs must redact machine-specific paths
  before committing.

## 7. Compliance applicability gate (CMP-CN-01)

- **Decision (2026-09-19, owner: repo owner):** applicability gate — target
  `victorsalmon/certn-client` (Canadian screening client library, no tenant
  store; provider scopes case ids); region Canada (production base URL
  `https://api.ca.certn.co`); PIPEDA applies to consumer-held applicant data
  (see `docs/RETENTION.md` minimization/deletion duties), GDPR only where a
  consumer processes EU residents' data; no data-sovereignty representation
  beyond the production-URL fact; no repo-native compliance engine (generic
  survey ran `primary`), no `.compliance-audit.yml` yet.
- **Rationale:** record once so future audits do not re-derive the gate on
  safest defaults.
- **Follow-up:** write `.compliance-audit.yml` on the first interactive
  compliance run.

## 8. Sandbox host jurisdiction (CMP-CN-01)

- **Decision (2026-09-19, owner: maintainer):** keep the no-claim stance —
  production base URL `https://api.ca.certn.co` is Canadian; the sandbox host
  (`https://api.sandbox.certn.co`) storage jurisdiction is undocumented and
  no residency promise is made. Pointed at `docs/RETENTION.md`; see README
  Data retention.
- **Rationale:** avoid over-claiming without provider evidence; revisit if a
  residency representation is required for consumers.

## 9. `AGENTS.md` (AL-CN-03)

- **Decision (2026-09-19, owner: maintainer):** do not add `AGENTS.md`;
  README/CONTRIBUTING remain the sole orientation, consistent with sibling
  `Public/*` client libraries.
- **Rationale:** no agent workflows exist in this repo to document; revisit
  if the repo gains them.
