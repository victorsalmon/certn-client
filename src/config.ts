/**
 * Certn client configuration.
 *
 * The client targets the current Certn Centric API only:
 *   - sandbox: https://api.sandbox.certn.co
 *   - production: https://api.ca.certn.co
 *   - auth: Authorization: Api-Key <key>
 *
 * The retired /token/, /api/v1/pm/, /api/v1/users/, and Bearer-token
 * surfaces must not be used.
 */

import { DEFAULT_PROFILE_NAME } from './profiles.js';

export interface CertnClientConfig {
  baseUrl: string;
  apiKey: string;
  /** HMAC secret configured for the Certn webhook endpoint. */
  webhookSecret: string;
  /** Allow-listed profile name resolved at construction (identity|credit|risk). */
  profileName?: string;
  /** Optional case group (Certn `group`), tags, and applicant language. */
  group?: string;
  tags?: string[];
  applicantLanguage?: string;
  /**
   * Default timeout in milliseconds for Certn API requests
   * (order, detail, cancel, generate-report, report-file poll).
   * Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. Must be positive.
   */
  requestTimeoutMs?: number;
  /**
   * Timeout in milliseconds for the signed PDF download.
   * Defaults to {@link DEFAULT_PDF_DOWNLOAD_TIMEOUT_MS}. Must be positive.
   */
  pdfDownloadTimeoutMs?: number;
  /**
   * Delay in milliseconds before the single retry on HTTP 429/5xx.
   * Defaults to {@link DEFAULT_RETRY_DELAY_MS}. Must be non-negative.
   */
  retryDelayMs?: number;
}

/** Default timeout for Certn API requests (15 s). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Default timeout for the signed PDF download (30 s). */
export const DEFAULT_PDF_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Default delay before the single retry on HTTP 429/5xx (500 ms). */
export const DEFAULT_RETRY_DELAY_MS = 500;

export const CERTN_SANDBOX_BASE_URL = 'https://api.sandbox.certn.co';
export const CERTN_PRODUCTION_BASE_URL = 'https://api.ca.certn.co';

/** Environment name that selects the Certn production base URL. */
const CERTN_PRODUCTION_ENVIRONMENT = 'production';

/**
 * Build a {@link CertnClientConfig} from environment variables.
 *
 * Reads:
 *   - `CERTN_API_KEY` (required)
 *   - `CERTN_WEBHOOK_SECRET` (required)
 *   - `CERTN_BASE_URL` (optional; falls back to sandbox/production by `CERTN_ENVIRONMENT`)
 *   - `CERTN_ENVIRONMENT` (optional; `production` → production base URL, else sandbox)
 *   - `CERTN_PROFILE` (optional; defaults to `identity`)
 *   - `CERTN_GROUP`, `CERTN_TAGS` (JSON array), `CERTN_APPLICANT_LANGUAGE` (optional)
 *
 * Throws on missing required values so misconfiguration fails loudly.
 */
export function createCertnConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CertnClientConfig {
  const apiKey = env.CERTN_API_KEY;
  const webhookSecret = env.CERTN_WEBHOOK_SECRET;
  if (!apiKey) throw new Error('Missing required env var: CERTN_API_KEY');
  if (!webhookSecret) throw new Error('Missing required env var: CERTN_WEBHOOK_SECRET');

  const baseUrl =
    env.CERTN_BASE_URL ??
    (env.CERTN_ENVIRONMENT === CERTN_PRODUCTION_ENVIRONMENT
      ? CERTN_PRODUCTION_BASE_URL
      : CERTN_SANDBOX_BASE_URL);

  return {
    baseUrl,
    apiKey,
    webhookSecret,
    profileName: env.CERTN_PROFILE ?? DEFAULT_PROFILE_NAME,
    group: env.CERTN_GROUP || undefined,
    tags: parseTags(env.CERTN_TAGS),
    applicantLanguage: env.CERTN_APPLICANT_LANGUAGE || undefined,
  };
}

/** Parse a JSON-array `CERTN_TAGS`; invalid input is an empty list (fail safe). */
function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}
