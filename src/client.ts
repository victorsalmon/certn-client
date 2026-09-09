/**
 * Certn Centric screening client.
 *
 * A product-neutral TypeScript client for the Certn Centric screening API:
 *   - case order: POST /api/public/cases/order/
 *   - case detail: GET /api/public/cases/{id}
 *   - case cancel: POST /api/public/cases/{id}/cancel/
 *   - report generation: POST /api/public/cases/{id}/generate-report/
 *   - report file: GET /api/public/cases/report-files/{id}/
 *   - webhook verification: HMAC-SHA256 over the raw body (X-Signature header)
 *
 * Auth is `Authorization: Api-Key <key>`. The retired /token/, /api/v1/pm/,
 * /api/v1/users/, and Bearer-token surfaces are not used.
 */

import { createHmac } from 'node:crypto';
import type {
  ScreeningInvitation,
  ScreeningReport,
  WebhookResult,
} from './types.js';
import { CertnWebhookSignatureError } from './types.js';
import { safeEqual } from './util.js';
import { DEFAULT_PROFILE_NAME, getScreeningProfile } from './profiles.js';
import {
  DEFAULT_PDF_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
} from './config.js';
import type { CertnClientConfig } from './config.js';

type JsonObject = Record<string, unknown>;

/** Return a non-empty string, or `undefined` for non-strings and empty values. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Find a header by name, ignoring case (HTTP headers are case-insensitive). */
function getHeaderValueCaseInsensitive(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** Treat a value as a plain object; arrays and non-objects become an empty object. */
function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

/** Throw unless `email` is a non-empty, plausibly-shaped email address. */
function assertValidApplicantEmail(email: string): void {
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim())) {
    throw new Error('Invalid applicant email: expected a non-empty email address');
  }
}

/** Throw unless `caseId` is a non-empty, non-whitespace string. */
function assertValidCaseId(caseId: string): void {
  if (typeof caseId !== 'string' || caseId.trim().length === 0) {
    throw new Error('Invalid case id: expected a non-empty case id');
  }
}

/** True for the statuses the client retries once (HTTP 429 or any 5xx). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Return the first finite number, or the first numeric string coerced to a number. */
function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

/** Return the first boolean argument, or `null` if none is present. */
function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return null;
}

/** Pause for the given number of milliseconds. */
function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find the first check whose `type` contains the keyword, case-insensitively.
 * Certn check identifiers include a category prefix (e.g. `CREDIT_REPORT_1`).
 */
function findCheckByTypeKeyword(
  checks: JsonObject[],
  keyword: string
): JsonObject | undefined {
  return checks.find((check) => String(check.type ?? '').toUpperCase().includes(keyword));
}

/** Derive the normalized `idVerified` flag from an identity check, if present. */
function normalizeIdentityVerification(
  identityCheck: JsonObject | undefined
): boolean | null {
  if (identityCheck === undefined) return null;
  return firstBoolean(
    identityCheck.id_verified,
    identityCheck.idVerified,
    asString(identityCheck.score) === IDENTITY_SCORE_CLEAR ||
      asString(identityCheck.sub_score) === IDENTITY_SUB_SCORE_VERIFIED
  );
}

/** Build the PII-stripped check shape that is safe to persist. */
function toReportCheck(check: JsonObject): JsonObject {
  return {
    id: check.id,
    short_id: check.short_id,
    type: check.type,
    status: check.status,
    score: check.score,
    sub_score: check.sub_score,
    adjudication_score: check.adjudication_score,
    adjudication_sub_score: check.adjudication_sub_score,
  };
}

// Certn API protocol constants. Keeping them as named values makes it easier to
// see which literals are domain tokens and prevents drift if the API changes.
const CERTN_API_KEY_PREFIX = 'Api-Key ';
const PDF_REPORT_LANGUAGE = 'en-CA';
const MAX_PDF_POLL_ATTEMPTS = 10;
const PDF_POLL_INTERVAL_MS = 750;

const CASE_STATUS_COMPLETE = 'COMPLETE';
const CASE_STATUS_FAILED = 'FAILED';
const CASE_STATUS_CANCELLED = 'CANCELLED';
const CASE_STATUS_CLIENT_ACTION_REQUIRED = 'CLIENT_ACTION_REQUIRED';
const CASE_STATUS_APPLICANT_ACTION_REQUIRED = 'APPLICANT_ACTION_REQUIRED';

const WEBHOOK_EVENT_CASE_REPORT_READY = 'CASE_REPORT_READY';
const WEBHOOK_EVENT_CASE_STATUS_CHANGED = 'CASE_STATUS_CHANGED';

const IDENTITY_SCORE_CLEAR = 'CLEAR';
const IDENTITY_SUB_SCORE_VERIFIED = 'VERIFIED';

const CREDIT_CHECK_TYPE_KEYWORD = 'CREDIT';
const IDENTITY_CHECK_TYPE_KEYWORD = 'IDENTITY';

const SHA256_SIGNATURE_PREFIX_PATTERN = /^sha256=/i;

/** Product-neutral Certn Centric screening client. */
export class CertnClient {
  private readonly baseUrl: string;

  constructor(private readonly config: CertnClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  /**
   * Order a screening case for an applicant and return the invite link.
   *
   * `profileName` (allow-listed) selects which checks to order; it overrides
   * the configured `config.profileName`. The returned `purchaseToken` is the
   * Certn case id used by subsequent calls (fetchReport, fetchPdf, cancelCase).
   *
   * `_applicantName` is intentionally ignored: Certn's public API does not accept
   * an applicant name in the order payload.
   *
   * Throws before any network call on an empty/malformed `applicantEmail`.
   * Retries once (after a bounded delay) on HTTP 429/5xx; other 4xx fail fast.
   * Every attempt aborts after `config.requestTimeoutMs` (default 15 s).
   */
  async invite(
    applicantEmail: string,
    profileName?: string,
    _applicantName?: string
  ): Promise<ScreeningInvitation> {
    assertValidApplicantEmail(applicantEmail);
    const profile = getScreeningProfile(profileName ?? this.config.profileName ?? DEFAULT_PROFILE_NAME);
    const data = await this.request<JsonObject>('/api/public/cases/order/', {
      method: 'POST',
      body: JSON.stringify({
        email_address: applicantEmail,
        send_invite_email: false,
        return_invite_link: true,
        check_types_with_arguments: profile.checkTypesWithArguments,
        ...(this.config.group ? { group: this.config.group } : {}),
        ...(this.config.tags && this.config.tags.length ? { tags: this.config.tags } : {}),
        ...(this.config.applicantLanguage
          ? { applicant_language: this.config.applicantLanguage }
          : {}),
      }),
    }, { retry: true });
    const caseId = asString(data.id);
    const inviteLink = asString(data.invite_link);
    if (!caseId || !inviteLink) {
      throw new Error('Certn order response missing id/invite_link');
    }
    return { purchaseToken: caseId, secureLink: inviteLink };
  }

  /**
   * Cancel a Certn case (POST /api/public/cases/{id}/cancel/).
   * Throws before any network call on an empty/whitespace `caseId`.
   */
  async cancelCase(caseId: string): Promise<void> {
    assertValidCaseId(caseId);
    await this.request<JsonObject>(`/api/public/cases/${encodeURIComponent(caseId)}/cancel/`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  /**
   * Fetch + normalize a case report by case id.
   * Throws before any network call on an empty/whitespace `caseId`.
   * Retries once (after a bounded delay) on HTTP 429/5xx; other 4xx fail fast.
   */
  async fetchReport(caseId: string): Promise<ScreeningReport> {
    assertValidCaseId(caseId);
    const data = await this.request<JsonObject>(
      `/api/public/cases/${encodeURIComponent(caseId)}`,
      { method: 'GET' },
      { retry: true }
    );
    return this.mapReport(data);
  }

  /**
   * Generate + download a case report PDF. Polls the report-file endpoint
   * every 750ms (fixed interval, up to 10 attempts) until COMPLETE, then
   * downloads the signed `pdf_url`. Throws before any network call on an
   * empty/whitespace `caseId`. API calls abort after
   * `config.requestTimeoutMs` (default 15 s); the PDF download aborts after
   * `config.pdfDownloadTimeoutMs` (default 30 s).
   */
  async fetchPdf(caseId: string): Promise<Buffer> {
    assertValidCaseId(caseId);
    const generated = await this.request<JsonObject>(
      `/api/public/cases/${encodeURIComponent(caseId)}/generate-report/`,
      {
        method: 'POST',
        body: JSON.stringify({ language: PDF_REPORT_LANGUAGE }),
      }
    );
    const reportFileId = asString(generated.case_report_file_id);
    if (!reportFileId) throw new Error('Certn report response missing case_report_file_id');

    for (let attempt = 0; attempt < MAX_PDF_POLL_ATTEMPTS; attempt++) {
      const file = await this.request<JsonObject>(
        `/api/public/cases/report-files/${encodeURIComponent(reportFileId)}/`,
        { method: 'GET' }
      );
      const status = asString(file.status);
      if (status === CASE_STATUS_FAILED) throw new Error('Certn report generation failed');
      const pdfUrl = asString(file.pdf_url);
      if (status === CASE_STATUS_COMPLETE && pdfUrl) {
        const response = await this.fetchWithTimeout(
          pdfUrl,
          {},
          this.config.pdfDownloadTimeoutMs ?? DEFAULT_PDF_DOWNLOAD_TIMEOUT_MS,
          'GET PDF download'
        );
        if (!response.ok) throw new Error(`Certn PDF download failed: HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      }
      await waitMs(PDF_POLL_INTERVAL_MS);
    }
    throw new Error('Certn report PDF did not become available before timeout');
  }

  /**
   * Verify the X-Signature HMAC over the raw body and map the webhook event
   * into a normalized {@link WebhookResult}. Throws
   * {@link CertnWebhookSignatureError} (statusCode 401) on missing/invalid
   * signatures.
   */
  async parseWebhook(
    payload: unknown,
    headers: Record<string, string>,
    rawBody?: string
  ): Promise<WebhookResult> {
    const signature = getHeaderValueCaseInsensitive(headers, 'X-Signature');
    if (!rawBody || !this.validSignature(signature, rawBody)) {
      throw new CertnWebhookSignatureError();
    }

    const body = asObject(payload);
    const caseId = asString(body.object_id) ?? '';
    if (!caseId) return { applicationId: '', status: 'error' };

    const eventType = asString(body.event_type);
    const eventId = asString(body.event_id);
    const caseStatus = asString(body.case_status);
    // Report processing is asynchronous. CASE_REPORT_READY is the reliable
    // completion signal; COMPLETE is also accepted for integrations that only
    // subscribe to CASE_STATUS_CHANGED.
    const complete =
      eventType === WEBHOOK_EVENT_CASE_REPORT_READY ||
      (eventType === WEBHOOK_EVENT_CASE_STATUS_CHANGED && caseStatus === CASE_STATUS_COMPLETE);
    if (complete) {
      return {
        applicationId: caseId,
        status: 'completed',
        report: await this.fetchReport(caseId),
        eventId,
      };
    }
    if (caseStatus === CASE_STATUS_CANCELLED) {
      return { applicationId: caseId, status: 'error', eventId };
    }
    return {
      applicationId: caseId,
      status: 'in_progress',
      eventId,
      actionRequired:
        caseStatus === CASE_STATUS_CLIENT_ACTION_REQUIRED ||
        caseStatus === CASE_STATUS_APPLICANT_ACTION_REQUIRED,
    };
  }

  /** Verify a webhook signature against the configured secret (hex or base64). */
  verifyWebhook(signature: string | undefined, rawBody: string): boolean {
    return this.validSignature(signature, rawBody);
  }

  private validSignature(signature: string | undefined, rawBody: string): boolean {
    if (!signature || !this.config.webhookSecret) return false;
    const supplied = signature.replace(SHA256_SIGNATURE_PREFIX_PATTERN, '').trim();
    const digest = createHmac('sha256', this.config.webhookSecret).update(rawBody).digest();
    const expectedHex = digest.toString('hex');
    const expectedBase64 = digest.toString('base64');
    return safeEqual(supplied, expectedHex) || safeEqual(supplied, expectedBase64);
  }

  /**
   * Internal request helper — exported for testing as a private member.
   *
   * Every attempt aborts after `config.requestTimeoutMs` (default 15 s).
   * When `opts.retry` is set (invite/fetchReport only), a single retry
   * follows an HTTP 429/5xx after a bounded delay (`config.retryDelayMs`,
   * default 500 ms). Other 4xx, timeouts, network errors, and
   * webhook-signature failures are never retried.
   */
  private async request<T>(
    path: string,
    init: RequestInit,
    opts: { retry?: boolean } = {}
  ): Promise<T> {
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const retryDelayMs = this.config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const attempts = opts.retry ? 2 : 1;
    const url = `${this.baseUrl}${path}`;
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `${CERTN_API_KEY_PREFIX}${this.config.apiKey}`,
      ...(init.headers ?? {}),
    };
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchWithTimeout(
        url,
        { ...init, headers },
        timeoutMs,
        `${init.method ?? 'GET'} ${path}`
      );
      if (response.ok) return (await response.json()) as T;
      if (opts.retry && attempt + 1 < attempts && isRetryableStatus(response.status)) {
        await waitMs(retryDelayMs);
        continue;
      }
      throw new Error(
        `Certn request failed: ${init.method ?? 'GET'} ${path}: HTTP ${response.status}`
      );
    }
  }

  /**
   * `fetch` wrapper that aborts after `timeoutMs` via `AbortSignal.timeout`
   * and maps the abort to a `Certn request timed out` error. Other fetch
   * rejections (network errors) propagate unchanged.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    label: string
  ): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await fetch(url, { ...init, signal });
    } catch (err) {
      if (signal.aborted) {
        throw new Error(`Certn request timed out: ${label} after ${timeoutMs}ms`);
      }
      throw err;
    }
  }

  private mapReport(data: JsonObject): ScreeningReport {
    const checks = Array.isArray(data.checks) ? data.checks.map(asObject) : [];
    const creditCheck = findCheckByTypeKeyword(checks, CREDIT_CHECK_TYPE_KEYWORD);
    const identityCheck = findCheckByTypeKeyword(checks, IDENTITY_CHECK_TYPE_KEYWORD);
    const creditClaims = asObject(creditCheck?.output_claims);

    // Store only normalized outcomes and check metadata. Do not persist
    // input_claims, output_claims, email addresses, or identity documents.
    const reportJsonb: JsonObject = {
      id: data.id,
      short_id: data.short_id,
      created: data.created,
      overall_status: data.overall_status,
      overall_score: data.overall_score,
      checks: checks.map(toReportCheck),
    };

    return {
      creditScore: firstNumber(
        creditClaims.credit_score,
        creditClaims.creditScore,
        creditCheck?.credit_score,
        creditCheck?.creditScore
      ),
      // Eviction outcomes are not measured by this client — always null.
      evictionCount: null,
      idVerified: normalizeIdentityVerification(identityCheck),
      reportJsonb,
      // Never fabricate a timestamp: null when the provider supplies neither.
      completedAt: asString(data.modified) ?? asString(data.created) ?? null,
    };
  }
}

/** Factory matching the vopay-client pattern (`createCertnClient(config)`). */
export function createCertnClient(config: CertnClientConfig): CertnClient {
  return new CertnClient(config);
}
