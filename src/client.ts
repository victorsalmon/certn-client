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
import { getScreeningProfile } from './profiles.js';
import type { CertnClientConfig } from './config.js';

type JsonObject = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
   */
  async invite(
    applicantEmail: string,
    profileName?: string,
    _applicantName?: string
  ): Promise<ScreeningInvitation> {
    const profile = getScreeningProfile(profileName ?? this.config.profileName ?? 'identity');
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
    });
    const caseId = asString(data.id);
    const inviteLink = asString(data.invite_link);
    if (!caseId || !inviteLink) {
      throw new Error('Certn order response missing id/invite_link');
    }
    return { purchaseToken: caseId, secureLink: inviteLink };
  }

  /** Cancel a Certn case (POST /api/public/cases/{id}/cancel/). */
  async cancelCase(caseId: string): Promise<void> {
    await this.request<JsonObject>(`/api/public/cases/${encodeURIComponent(caseId)}/cancel/`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  /** Fetch + normalize a case report by case id. */
  async fetchReport(caseId: string): Promise<ScreeningReport> {
    const data = await this.request<JsonObject>(
      `/api/public/cases/${encodeURIComponent(caseId)}`,
      { method: 'GET' }
    );
    return this.mapReport(data);
  }

  /**
   * Generate + download a case report PDF. Polls the report-file endpoint
   * (750ms backoff, up to 10 attempts) until COMPLETE, then downloads the
   * signed `pdf_url`.
   */
  async fetchPdf(caseId: string): Promise<Buffer> {
    const generated = await this.request<JsonObject>(
      `/api/public/cases/${encodeURIComponent(caseId)}/generate-report/`,
      {
        method: 'POST',
        body: JSON.stringify({ language: 'en-CA' }),
      }
    );
    const reportFileId = asString(generated.case_report_file_id);
    if (!reportFileId) throw new Error('Certn report response missing case_report_file_id');

    for (let attempt = 0; attempt < 10; attempt++) {
      const file = await this.request<JsonObject>(
        `/api/public/cases/report-files/${encodeURIComponent(reportFileId)}/`,
        { method: 'GET' }
      );
      const status = asString(file.status);
      if (status === 'FAILED') throw new Error('Certn report generation failed');
      const pdfUrl = asString(file.pdf_url);
      if (status === 'COMPLETE' && pdfUrl) {
        const response = await fetch(pdfUrl);
        if (!response.ok) throw new Error(`Certn PDF download failed: HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      }
      await delay(750);
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
    const signature = getHeader(headers, 'X-Signature');
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
      eventType === 'CASE_REPORT_READY' ||
      (eventType === 'CASE_STATUS_CHANGED' && caseStatus === 'COMPLETE');
    if (complete) {
      return {
        applicationId: caseId,
        status: 'completed',
        report: await this.fetchReport(caseId),
        eventId,
      };
    }
    if (caseStatus === 'CANCELLED') {
      return { applicationId: caseId, status: 'error', eventId };
    }
    return {
      applicationId: caseId,
      status: 'in_progress',
      eventId,
      actionRequired:
        caseStatus === 'CLIENT_ACTION_REQUIRED' || caseStatus === 'APPLICANT_ACTION_REQUIRED',
    };
  }

  /** Verify a webhook signature against the configured secret (hex or base64). */
  verifyWebhook(signature: string | undefined, rawBody: string): boolean {
    return this.validSignature(signature, rawBody);
  }

  private validSignature(signature: string | undefined, rawBody: string): boolean {
    if (!signature || !this.config.webhookSecret) return false;
    const supplied = signature.replace(/^sha256=/i, '').trim();
    const digest = createHmac('sha256', this.config.webhookSecret).update(rawBody).digest();
    const expectedHex = digest.toString('hex');
    const expectedBase64 = digest.toString('base64');
    return safeEqual(supplied, expectedHex) || safeEqual(supplied, expectedBase64);
  }

  /** Internal request helper — exported for testing as a private member. */
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Api-Key ${this.config.apiKey}`,
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(
        `Certn request failed: ${init.method ?? 'GET'} ${path}: HTTP ${response.status}`
      );
    }
    return (await response.json()) as T;
  }

  private mapReport(data: JsonObject): ScreeningReport {
    const checks = Array.isArray(data.checks) ? data.checks.map(asObject) : [];
    const creditCheck = checks.find((check) =>
      String(check.type ?? '')
        .toUpperCase()
        .includes('CREDIT')
    );
    const identityCheck = checks.find((check) =>
      String(check.type ?? '')
        .toUpperCase()
        .includes('IDENTITY')
    );
    const creditClaims = asObject(creditCheck?.output_claims);
    const identityScore = asString(identityCheck?.score);
    const identitySubScore = asString(identityCheck?.sub_score);

    // Store only normalized outcomes and check metadata. Do not persist
    // input_claims, output_claims, email addresses, or identity documents.
    const reportJsonb: JsonObject = {
      id: data.id,
      short_id: data.short_id,
      created: data.created,
      overall_status: data.overall_status,
      overall_score: data.overall_score,
      checks: checks.map((check) => ({
        id: check.id,
        short_id: check.short_id,
        type: check.type,
        status: check.status,
        score: check.score,
        sub_score: check.sub_score,
        adjudication_score: check.adjudication_score,
        adjudication_sub_score: check.adjudication_sub_score,
      })),
    };

    return {
      creditScore: firstNumber(
        creditClaims.credit_score,
        creditClaims.creditScore,
        creditCheck?.credit_score,
        creditCheck?.creditScore
      ),
      evictionCount: null,
      idVerified:
        identityCheck === undefined
          ? null
          : firstBoolean(
              identityCheck.id_verified,
              identityCheck.idVerified,
              identityScore === 'CLEAR' || identitySubScore === 'VERIFIED'
            ),
      reportJsonb,
      completedAt: asString(data.modified) ?? asString(data.created) ?? new Date().toISOString(),
    };
  }
}

/** Factory matching the vopay-client pattern (`createCertnClient(config)`). */
export function createCertnClient(config: CertnClientConfig): CertnClient {
  return new CertnClient(config);
}
