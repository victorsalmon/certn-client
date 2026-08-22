/**
 * Product-neutral screening types consumed by the Certn client.
 *
 * These mirror the shapes a screening integration typically needs (an
 * invitation result, a normalized report, a webhook outcome) without any
 * application-specific coupling. Consuming apps can map these into their own
 * domain models.
 */

/** A completed screening report for one applicant. */
export interface ScreeningReport {
  creditScore: number | null;
  evictionCount: number | null;
  idVerified: boolean | null;
  /** Provider-specific raw payload (PII-stripped — see client.mapReport). */
  reportJsonb: Record<string, unknown>;
  completedAt: string;
}

/** Status the client maps a webhook event into. */
export type WebhookStatus = 'completed' | 'in_progress' | 'error';

/** Result of parsing a provider webhook payload. */
export interface WebhookResult {
  /** Certn case id (maps to the consuming app's application token). */
  applicationId: string;
  status: WebhookStatus;
  report?: ScreeningReport;
  /**
   * Certn `event_id`. Persisted by the consumer as a (provider, event_id)
   * receipt so webhook retries and out-of-order duplicates are no-ops.
   */
  eventId?: string;
  /**
   * True when Certn reports `APPLICANT_ACTION_REQUIRED` or
   * `CLIENT_ACTION_REQUIRED`. Surfaced to staff work queues; never
   * auto-decides the tenancy outcome.
   */
  actionRequired?: boolean;
}

/** Invitation result — the applicant-facing secure link + purchase token. */
export interface ScreeningInvitation {
  secureLink: string;
  purchaseToken: string;
}

/**
 * Error thrown when a Certn webhook signature is missing or invalid.
 * Carries a `statusCode` of 401 so consuming apps can map it to their HTTP
 * response without re-throwing.
 */
export class CertnWebhookSignatureError extends Error {
  readonly statusCode = 401;
  constructor(message = 'Invalid Certn webhook signature') {
    super(message);
    this.name = 'CertnWebhookSignatureError';
  }
}
