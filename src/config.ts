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
}

export const CERTN_SANDBOX_BASE_URL = 'https://api.sandbox.certn.co';
export const CERTN_PRODUCTION_BASE_URL = 'https://api.ca.certn.co';

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
    (env.CERTN_ENVIRONMENT === 'production' ? CERTN_PRODUCTION_BASE_URL : CERTN_SANDBOX_BASE_URL);

  return {
    baseUrl,
    apiKey,
    webhookSecret,
    profileName: env.CERTN_PROFILE ?? 'identity',
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
