import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CertnClient, createCertnClient } from '../src/client.js';
import { CertnWebhookSignatureError } from '../src/types.js';
import { isScreeningProfile, getScreeningProfile } from '../src/profiles.js';
import { createCertnConfigFromEnv } from '../src/config.js';
import { verifySecret, safeEqual } from '../src/util.js';

const BASE_URL = 'https://api.sandbox.certn.co';
const WEBHOOK_SECRET = 'certn-webhook-test-secret';

function makeClient(): CertnClient {
  return new CertnClient({
    baseUrl: BASE_URL,
    apiKey: 'certn-api-key',
    webhookSecret: WEBHOOK_SECRET,
    profileName: 'identity',
  });
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function signature(body: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

beforeEach(() => {
  // fetchPdf polls report files with a 750ms backoff; the poll count contract
  // is what we care about, not the real-time wait.
  vi.stubGlobal('setTimeout', (cb: () => void, _ms?: number) => {
    cb();
    return 0 as unknown as NodeJS.Timeout;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of [
    'CERTN_API_KEY',
    'CERTN_WEBHOOK_SECRET',
    'CERTN_BASE_URL',
    'CERTN_PROFILE',
    'CERTN_ENVIRONMENT',
  ])
    delete process.env[name];
});

describe('CertnClient', () => {
  it('orders an invite through the current public case endpoint with Api-Key auth', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/api/public/cases/order/`);
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Api-Key certn-api-key');
      expect(JSON.parse(String(init?.body))).toEqual({
        email_address: 'jane@example.com',
        send_invite_email: false,
        return_invite_link: true,
        check_types_with_arguments: { IDENTITY_VERIFICATION_1: {} },
      });
      return okJson({ id: 'case-123', invite_link: 'https://app.certn.co/invite/case-123' }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeClient().invite('jane@example.com')).resolves.toEqual({
      purchaseToken: 'case-123',
      secureLink: 'https://app.certn.co/invite/case-123',
    });
  });

  it('retrieves a case and strips applicant claims from the normalized report', async () => {
    const raw = {
      id: 'case-123',
      short_id: 'C123',
      created: '2026-08-21T10:00:00Z',
      overall_status: 'COMPLETE',
      overall_score: 'CLEAR',
      input_claims: { date_of_birth: '1990-01-01' },
      checks: [
        {
          id: 'check-1',
          type: 'IDENTITY_VERIFICATION_1',
          status: 'COMPLETE',
          score: 'CLEAR',
          sub_score: 'VERIFIED',
          output_claims: { document_number: 'should-not-persist' },
        },
      ],
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/api/public/cases/case-123`);
      expect(init?.method).toBe('GET');
      const headers = (init?.headers as Record<string, string>) ?? {};
      expect(headers.Accept).toBe('application/json');
      expect(headers.Authorization).toBe('Api-Key certn-api-key');
      return okJson(raw);
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = await makeClient().fetchReport('case-123');
    expect(report.idVerified).toBe(true);
    expect(report.reportJsonb).not.toHaveProperty('input_claims');
    expect(JSON.stringify(report.reportJsonb)).not.toContain('should-not-persist');
  });

  it('uses generate-report then the signed report-file URL for PDF retrieval', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/generate-report/')) {
        expect(init?.method).toBe('POST');
        const headers = (init?.headers as Record<string, string>) ?? {};
        expect(headers.Accept).toBe('application/json');
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers.Authorization).toBe('Api-Key certn-api-key');
        expect(JSON.parse(String(init?.body))).toEqual({ language: 'en-CA' });
        return okJson({ case_report_file_id: 'file-123' }, 201);
      }
      if (url.endsWith('/report-files/file-123/')) {
        expect(init?.method).toBe('GET');
        return okJson({ status: 'COMPLETE', pdf_url: 'https://signed.certn.test/report.pdf' });
      }
      if (url === 'https://signed.certn.test/report.pdf')
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const pdf = await makeClient().fetchPdf('case-123');
    expect([...pdf]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('verifies the raw-body X-Signature and maps CASE_REPORT_READY', async () => {
    const rawBody = JSON.stringify({
      event_id: 'event-1',
      event_type: 'CASE_REPORT_READY',
      object_id: 'case-123',
      object_type: 'CASE',
      case_status: 'COMPLETE',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ id: 'case-123', overall_status: 'COMPLETE', checks: [] }))
    );

    const result = await makeClient().parseWebhook(
      JSON.parse(rawBody),
      { 'X-Signature': signature(rawBody) },
      rawBody
    );
    expect(result).toMatchObject({ applicationId: 'case-123', status: 'completed' });
  });

  it('rejects missing or invalid signatures with a 401 CertnWebhookSignatureError', async () => {
    const body = JSON.stringify({ event_type: 'CASE_STATUS_CHANGED', object_id: 'case-123' });
    await expect(makeClient().parseWebhook(JSON.parse(body), {}, body)).rejects.toBeInstanceOf(
      CertnWebhookSignatureError
    );
    await expect(
      makeClient().parseWebhook(JSON.parse(body), { 'X-Signature': 'wrong' }, body)
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('strips optional sha256= prefix and trims trailing whitespace from the X-Signature', async () => {
    const rawBody = JSON.stringify({ event_type: 'CASE_REPORT_READY', object_id: 'case-123' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ id: 'case-123', overall_status: 'COMPLETE', checks: [] }))
    );
    const hex = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    await expect(
      makeClient().parseWebhook(
        JSON.parse(rawBody),
        { 'X-Signature': `sha256=${hex}  ` },
        rawBody
      )
    ).resolves.toMatchObject({ status: 'completed' });
  });

  it('verifies HMAC over exact raw bytes (UTF-8 body; hex and base64 forms)', async () => {
    const rawBody = JSON.stringify({
      event_id: 'event-utf8',
      event_type: 'CASE_REPORT_READY',
      object_id: 'case-123',
      note: 'café — Montréal résumé',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ id: 'case-123', overall_status: 'COMPLETE', checks: [] }))
    );

    const hex = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    const base64 = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('base64');

    const viaHex = await makeClient().parseWebhook(
      JSON.parse(rawBody),
      { 'X-Signature': `sha256=${hex}` },
      rawBody
    );
    expect(viaHex.status).toBe('completed');

    const viaBase64 = await makeClient().parseWebhook(
      JSON.parse(rawBody),
      { 'X-Signature': base64 },
      rawBody
    );
    expect(viaBase64.status).toBe('completed');
  });

  it('rejects same-length wrong digests and signature strings without a body', async () => {
    const body = JSON.stringify({ event_type: 'CASE_STATUS_CHANGED', object_id: 'case-123' });
    const correct = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    const tampered = (correct[0] === 'a' ? 'b' : 'a') + correct.slice(1);

    await expect(
      makeClient().parseWebhook(JSON.parse(body), { 'X-Signature': tampered }, body)
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      makeClient().parseWebhook(JSON.parse(body), { 'X-Signature': '' }, '')
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('fails closed when the webhook secret is unset (empty config)', async () => {
    const body = JSON.stringify({ event_type: 'CASE_STATUS_CHANGED', object_id: 'case-123' });
    const client = new CertnClient({
      baseUrl: BASE_URL,
      apiKey: 'key',
      webhookSecret: '',
      profileName: 'identity',
    });
    const sig = createHmac('sha256', '').update(body).digest('hex');
    await expect(
      client.parseWebhook(JSON.parse(body), { 'X-Signature': sig }, body)
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('maps CASE_STATUS_CHANGED with case_status COMPLETE to completed and fetches the report', async () => {
    const rawBody = JSON.stringify({
      event_id: 'event-9',
      event_type: 'CASE_STATUS_CHANGED',
      object_id: 'case-123',
      case_status: 'COMPLETE',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJson({ id: 'case-123', short_id: 'C123', overall_status: 'COMPLETE', checks: [] })
      )
    );
    const result = await makeClient().parseWebhook(
      JSON.parse(rawBody),
      { 'X-Signature': signature(rawBody) },
      rawBody
    );
    expect(result).toMatchObject({
      applicationId: 'case-123',
      status: 'completed',
      eventId: 'event-9',
    });
  });

  it('maps CANCELLED case status to error and carries the event id', async () => {
    const rawBody = JSON.stringify({
      event_id: 'event-cancel',
      event_type: 'CASE_STATUS_CHANGED',
      object_id: 'case-123',
      case_status: 'CANCELLED',
    });
    const result = await makeClient().parseWebhook(
      JSON.parse(rawBody),
      { 'X-Signature': signature(rawBody) },
      rawBody
    );
    expect(result).toEqual({ applicationId: 'case-123', status: 'error', eventId: 'event-cancel' });
  });

  it('keeps non-terminal statuses in_progress with actionRequired flag', async () => {
    for (const caseStatus of [
      'CLIENT_ACTION_REQUIRED',
      'APPLICANT_ACTION_REQUIRED',
      'IN_PROGRESS',
      'APPLICANT_SUBMITTED',
    ]) {
      const rawBody = JSON.stringify({
        event_id: `event-${caseStatus}`,
        event_type: 'CASE_STATUS_CHANGED',
        object_id: 'case-123',
        case_status: caseStatus,
      });
      const result = await makeClient().parseWebhook(
        JSON.parse(rawBody),
        { 'X-Signature': signature(rawBody) },
        rawBody
      );
      expect(result).toMatchObject({
        applicationId: 'case-123',
        status: 'in_progress',
        eventId: `event-${caseStatus}`,
      });
      if (caseStatus === 'CLIENT_ACTION_REQUIRED' || caseStatus === 'APPLICANT_ACTION_REQUIRED') {
        expect(result.actionRequired).toBe(true);
      } else {
        expect(result.actionRequired).toBeFalsy();
      }
    }
  });

  it('returns error for a payload without object_id', async () => {
    const rawBody = JSON.stringify({ event_id: 'event-x', event_type: 'CASE_STATUS_CHANGED' });
    const result = await makeClient().parseWebhook(
      JSON.parse(rawBody),
      { 'X-Signature': signature(rawBody) },
      rawBody
    );
    expect(result).toEqual({ applicationId: '', status: 'error' });
  });

  it('fails when the report file generation is missing case_report_file_id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ status: 'COMPLETE' }, 201))
    );
    await expect(makeClient().fetchPdf('case-123')).rejects.toThrow(
      'missing case_report_file_id'
    );
  });

  it('fails when the report file status is FAILED', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/generate-report/')) return okJson({ case_report_file_id: 'file-1' }, 201);
      return okJson({ status: 'FAILED' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().fetchPdf('case-123')).rejects.toThrow(
      'Certn report generation failed'
    );
  });

  it('polls PENDING report files until COMPLETE', async () => {
    let poll = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/generate-report/')) return okJson({ case_report_file_id: 'file-1' }, 201);
      if (url.endsWith('/report-files/file-1/')) {
        poll++;
        return okJson(
          poll < 3
            ? { status: 'PENDING' }
            : { status: 'COMPLETE', pdf_url: 'https://signed.certn.test/r.pdf' }
        );
      }
      if (url === 'https://signed.certn.test/r.pdf')
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const pdf = await makeClient().fetchPdf('case-123');
    expect([...pdf]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(poll).toBe(3);
  });

  it('times out after 10 polling attempts when the report file stays PENDING', async () => {
    vi.useFakeTimers();
    try {
      let fileCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.endsWith('/generate-report/'))
            return okJson({ case_report_file_id: 'file-1' }, 201);
          fileCalls++;
          return okJson({ status: 'PENDING' });
        })
      );
      const promise = makeClient().fetchPdf('case-123');
      let settled = false;
      promise.catch(() => {
        settled = true;
      });
      for (let i = 0; i < 30 && !settled; i++) {
        await vi.advanceTimersByTimeAsync(750);
        await Promise.resolve();
        await Promise.resolve();
      }
      await expect(promise).rejects.toThrow('did not become available before timeout');
      expect(fileCalls).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes reports: missing identity check → idVerified null, camelCase credit claims mapped', async () => {
    const raw = {
      id: 'case-123',
      short_id: 'C123',
      created: '2026-08-21T10:00:00Z',
      overall_status: 'COMPLETE',
      checks: [
        {
          id: 'c1',
          type: 'CREDIT_REPORT_1',
          status: 'COMPLETE',
          output_claims: { creditScore: 715 },
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => okJson(raw)));
    const report = await makeClient().fetchReport('case-123');
    expect(report.idVerified).toBeNull();
    expect(report.creditScore).toBe(715);
  });

  it('normalizes reports: identity check with id_verified false and created fallback for completedAt', async () => {
    const raw = {
      id: 'case-123',
      created: '2026-08-21T10:00:00Z',
      overall_status: 'COMPLETE',
      checks: [
        {
          id: 'c1',
          type: 'IDENTITY_VERIFICATION_1',
          status: 'COMPLETE',
          id_verified: false,
          score: 'REVIEW',
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => okJson(raw)));
    const report = await makeClient().fetchReport('case-123');
    expect(report.idVerified).toBe(false);
    expect(report.completedAt).toBe('2026-08-21T10:00:00Z');
    expect(JSON.stringify(report.reportJsonb)).not.toContain('id_verified');
  });

  it('orders with the caller-selected allow-listed profile check types', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/api/public/cases/order/`);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        check_types_with_arguments: {
          CREDIT_REPORT_1: {
            ordering_type: 'EXPLICIT_ORDERING',
            explicit_check_type: ['CANADIAN_CREDIT_REPORT_1'],
          },
          IDENTITY_VERIFICATION_1: {},
        },
      });
      return okJson({ id: 'case-credit', invite_link: 'https://invite' }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);
    const invite = await makeClient().invite('jane@example.com', 'credit');
    expect(invite.purchaseToken).toBe('case-credit');
  });

  it('orders the risk profile with Canadian criminal + identity waterfall', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/api/public/cases/order/`);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        check_types_with_arguments: {
          CRIMINAL_RECORD_REPORT_1: {
            ordering_type: 'EXPLICIT_ORDERING',
            explicit_check_type: ['BASIC_CANADIAN_CRIMINAL_RECORD_REPORT_1'],
          },
          IDENTITY_VERIFICATION_1: {},
        },
      });
      return okJson({ id: 'case-risk', invite_link: 'https://invite' }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);
    const invite = await makeClient().invite('jane@example.com', 'risk');
    expect(invite.purchaseToken).toBe('case-risk');
  });

  it('exposes a case-sensitive allow-list predicate for profiles', () => {
    expect(isScreeningProfile('identity')).toBe(true);
    expect(isScreeningProfile('credit')).toBe(true);
    expect(isScreeningProfile('risk')).toBe(true);
    expect(isScreeningProfile('softcheck')).toBe(false);
    expect(isScreeningProfile('Identity')).toBe(false);
  });

  it('rejects unknown/legacy profile names instead of guessing check types', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ id: 'case-x', invite_link: 'https://invite' }, 201))
    );
    await expect(makeClient().invite('jane@example.com', 'softcheck')).rejects.toThrow(
      'Unknown screening profile'
    );
    await expect(makeClient().invite('jane@example.com', 'not-a-profile')).rejects.toThrow(
      /Unknown screening profile.*Allowed: identity, credit, risk/
    );
  });

  it('cancels a case through the Centric cancel endpoint', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/api/public/cases/case-123/cancel/`);
      expect(init?.method).toBe('POST');
      return okJson({}, 200);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().cancelCase('case-123')).resolves.toBeUndefined();
  });

  it('passes group, tags, and applicant language into the order payload when configured', async () => {
    const client = new CertnClient({
      baseUrl: BASE_URL,
      apiKey: 'certn-api-key',
      webhookSecret: WEBHOOK_SECRET,
      profileName: 'identity',
      group: 'group-tenancy',
      tags: ['tenant-screening'],
      applicantLanguage: 'en-CA',
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        group: 'group-tenancy',
        tags: ['tenant-screening'],
        applicant_language: 'en-CA',
      });
      return okJson({ id: 'case-g', invite_link: 'https://invite' }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);
    await client.invite('jane@example.com');
  });

  it('rejects a report file status that is not COMPLETE even when pdf_url is present', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/generate-report/')) return okJson({ case_report_file_id: 'file-1' }, 201);
      if (url.endsWith('/report-files/file-1/'))
        return okJson({ status: 'PENDING', pdf_url: 'https://signed.certn.test/r.pdf' });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().fetchPdf('case-123')).rejects.toThrow(
      'did not become available before timeout'
    );
  });

  it('propagates a PDF download HTTP error', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/generate-report/')) return okJson({ case_report_file_id: 'file-1' }, 201);
      if (url.endsWith('/report-files/file-1/'))
        return okJson({ status: 'COMPLETE', pdf_url: 'https://signed.certn.test/r.pdf' });
      if (url === 'https://signed.certn.test/r.pdf') return new Response('gone', { status: 404 });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().fetchPdf('case-123')).rejects.toThrow(
      'Certn PDF download failed: HTTP 404'
    );
  });

  it('CASE_REPORT_READY overrides a CANCELLED case_status', async () => {
    const rawBody = JSON.stringify({
      event_id: 'event-override',
      event_type: 'CASE_REPORT_READY',
      object_id: 'case-123',
      case_status: 'CANCELLED',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ id: 'case-123', overall_status: 'COMPLETE', checks: [] }))
    );
    const result = await makeClient().parseWebhook(
      JSON.parse(rawBody),
      { 'X-Signature': signature(rawBody) },
      rawBody
    );
    expect(result).toMatchObject({
      applicationId: 'case-123',
      status: 'completed',
      eventId: 'event-override',
    });
  });

  it('only calls current Centric public case endpoints with Api-Key auth (no deprecated surfaces)', async () => {
    const urls: string[] = [];
    const authHeaders: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(String(url));
      authHeaders.push(String((init?.headers as Record<string, string>)?.Authorization ?? ''));
      if (String(url).endsWith('/generate-report/'))
        return okJson({ case_report_file_id: 'f1' }, 201);
      if (String(url).includes('/report-files/')) {
        return okJson({ status: 'COMPLETE', pdf_url: 'https://signed.certn.test/r.pdf' });
      }
      if (String(url) === 'https://signed.certn.test/r.pdf') {
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      }
      return okJson(
        {
          id: 'case-123',
          invite_link: 'https://invite',
          short_id: 'C1',
          created: '2026-08-21T00:00:00Z',
          overall_status: 'COMPLETE',
          checks: [],
        },
        201
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const c = makeClient();
    await c.invite('x@y.com');
    await c.fetchReport('case-123');
    await c.fetchPdf('case-123');

    expect(urls.length).toBeGreaterThanOrEqual(4);
    const apiCalls = urls.filter((u) => u.startsWith(BASE_URL));
    expect(apiCalls.length).toBeGreaterThanOrEqual(4);
    expect(apiCalls.every((u) => u.startsWith(`${BASE_URL}/api/public/cases/`))).toBe(true);
    expect(apiCalls.some((u) => /\/token\/|api\/v1\/|api\/v2\/|legacy-cases/.test(u))).toBe(false);
    expect(authHeaders.filter(Boolean).every((h) => h.startsWith('Api-Key '))).toBe(true);
    expect(authHeaders.some((h) => h.startsWith('Bearer '))).toBe(false);
  });

  it('propagates provider 4xx/429/5xx responses as errors with the HTTP status', async () => {
    for (const status of [400, 401, 404, 429, 500]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ type: 'error' }), { status }))
      );
      await expect(makeClient().invite('x@y.com')).rejects.toThrow(`HTTP ${status}`);
      await expect(makeClient().fetchReport('case-123')).rejects.toThrow(`HTTP ${status}`);
    }
  });

  it('reports the request method in errors for POST requests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/cancel/')) {
          return new Response(JSON.stringify({ type: 'error' }), { status: 409 });
        }
        throw new Error(`Unexpected URL ${url}`);
      })
    );
    await expect(makeClient().cancelCase('case-123')).rejects.toThrow('Certn request failed: POST');
  });

  it('normalizes the full report JSON shape and check fields', async () => {
    const raw = {
      id: 'case-123',
      short_id: 'C123',
      created: '2026-08-21T10:00:00Z',
      modified: '2026-08-21T10:00:00Z',
      overall_status: 'COMPLETE',
      overall_score: 'CLEAR',
      checks: [
        {
          id: 'check-1',
          short_id: 'c1',
          type: 'IDENTITY_VERIFICATION_1',
          status: 'COMPLETE',
          score: 'CLEAR',
          sub_score: 'VERIFIED',
          adjudication_score: 'adjudication',
          adjudication_sub_score: 'adjudication-sub',
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => okJson(raw)));
    const report = await makeClient().fetchReport('case-123');
    expect(report.reportJsonb).toMatchObject({
      id: 'case-123',
      short_id: 'C123',
      created: '2026-08-21T10:00:00Z',
      overall_status: 'COMPLETE',
      overall_score: 'CLEAR',
    });
    expect((report.reportJsonb as Record<string, unknown>).checks).toEqual([
      expect.objectContaining({
        id: 'check-1',
        short_id: 'c1',
        type: 'IDENTITY_VERIFICATION_1',
        status: 'COMPLETE',
        score: 'CLEAR',
        sub_score: 'VERIFIED',
        adjudication_score: 'adjudication',
        adjudication_sub_score: 'adjudication-sub',
      }),
    ]);
  });

  it('computes idVerified from identity score and sub-score when explicit booleans are absent', async () => {
    const base = {
      id: 'case-123',
      created: '2026-08-21T10:00:00Z',
      overall_status: 'COMPLETE',
      checks: [
        {
          id: 'c1',
          type: 'IDENTITY_VERIFICATION_1',
          status: 'COMPLETE',
          score: 'CLEAR',
          sub_score: 'PENDING',
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJson({
          ...base,
          checks: [{ ...base.checks[0], sub_score: 'VERIFIED' }],
        })
      )
    );
    expect((await makeClient().fetchReport('case-123')).idVerified).toBe(true);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJson({
          ...base,
          checks: [{ ...base.checks[0], score: 'REVIEW', sub_score: 'PENDING' }],
        })
      )
    );
    expect((await makeClient().fetchReport('case-123')).idVerified).toBe(false);
  });
});

describe('createCertnConfigFromEnv', () => {
  it('builds a config from required env vars with sandbox fallback', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    const config = createCertnConfigFromEnv();
    expect(config.apiKey).toBe('api-key');
    expect(config.webhookSecret).toBe('webhook-secret');
    expect(config.baseUrl).toBe('https://api.sandbox.certn.co');
    expect(config.profileName).toBe('identity');
  });

  it('selects the production base URL when CERTN_ENVIRONMENT=production', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    process.env.CERTN_ENVIRONMENT = 'production';
    const config = createCertnConfigFromEnv();
    expect(config.baseUrl).toBe('https://api.ca.certn.co');
  });

  it('honors an explicit CERTN_BASE_URL over the environment fallback', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    process.env.CERTN_BASE_URL = 'https://custom.certn.test';
    const config = createCertnConfigFromEnv();
    expect(config.baseUrl).toBe('https://custom.certn.test');
  });

  it('throws on missing required values', () => {
    delete process.env.CERTN_API_KEY;
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    expect(() => createCertnConfigFromEnv()).toThrow('CERTN_API_KEY');
  });

  it('parses CERTN_TAGS as a JSON array', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    process.env.CERTN_TAGS = JSON.stringify(['a', 'b']);
    const config = createCertnConfigFromEnv();
    expect(config.tags).toEqual(['a', 'b']);
  });

  it('returns an empty tag list for invalid JSON', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    process.env.CERTN_TAGS = 'not-json';
    const config = createCertnConfigFromEnv();
    expect(config.tags).toEqual([]);
  });
});

describe('profiles', () => {
  it('exposes three allow-listed profiles', () => {
    expect(getScreeningProfile('identity').label).toBe('Identity verification');
    expect(getScreeningProfile('credit').label).toBe('Credit report');
    expect(getScreeningProfile('risk').label).toBe('Risk screening (criminal record)');
  });
});

describe('CertnClient – additional mutation-killing tests', () => {
  it('invite throws when response id is an empty string (asString rejects empty strings)', async () => {
    const fetchMock = vi.fn(async () => okJson({ id: '', invite_link: 'https://invite' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().invite('jane@example.com')).rejects.toThrow(
      'missing id/invite_link'
    );
  });

  it('invite throws when response invite_link is an empty string', async () => {
    const fetchMock = vi.fn(async () => okJson({ id: 'case-1', invite_link: '' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().invite('jane@example.com')).rejects.toThrow(
      'missing id/invite_link'
    );
  });

  it('invite throws when response id is a non-string type', async () => {
    const fetchMock = vi.fn(async () => okJson({ id: 123, invite_link: 'https://invite' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().invite('jane@example.com')).rejects.toThrow(
      'missing id/invite_link'
    );
  });

  it('parseWebhook matches X-Signature case-insensitively', async () => {
    const rawBody = JSON.stringify({
      event_id: 'event-ci',
      event_type: 'CASE_REPORT_READY',
      object_id: 'case-123',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ id: 'case-123', overall_status: 'COMPLETE', checks: [] }))
    );
    const hex = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    const result = await makeClient().parseWebhook(
      JSON.parse(rawBody),
      { 'x-signature': hex },
      rawBody
    );
    expect(result).toMatchObject({ status: 'completed' });
  });

  it('parseWebhook treats array payload as empty object (no object_id)', async () => {
    const rawBody = JSON.stringify({ event_type: 'CASE_STATUS_CHANGED' });
    vi.stubGlobal('fetch', vi.fn(async () => okJson({})));
    const hex = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    const result = await makeClient().parseWebhook([], { 'X-Signature': hex }, rawBody);
    expect(result).toEqual({ applicationId: '', status: 'error' });
  });

  it('fetchReport maps credit score from string numeric credit_score', async () => {
    const raw = {
      id: 'case-123',
      created: '2026-08-21T10:00:00Z',
      overall_status: 'COMPLETE',
      checks: [
        {
          id: 'c1',
          type: 'CREDIT_REPORT_1',
          status: 'COMPLETE',
          output_claims: { credit_score: '720' },
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => okJson(raw)));
    const report = await makeClient().fetchReport('case-123');
    expect(report.creditScore).toBe(720);
  });

  it('fetchReport returns null creditScore when credit_score is NaN string', async () => {
    const raw = {
      id: 'case-123',
      created: '2026-08-21T10:00:00Z',
      overall_status: 'COMPLETE',
      checks: [
        {
          id: 'c1',
          type: 'CREDIT_REPORT_1',
          status: 'COMPLETE',
          output_claims: { credit_score: 'not-a-number' },
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => okJson(raw)));
    const report = await makeClient().fetchReport('case-123');
    expect(report.creditScore).toBeNull();
  });

  it('fetchReport returns null creditScore when credit_score is Infinity', async () => {
    const raw = {
      id: 'case-123',
      created: '2026-08-21T10:00:00Z',
      overall_status: 'COMPLETE',
      checks: [
        {
          id: 'c1',
          type: 'CREDIT_REPORT_1',
          status: 'COMPLETE',
          output_claims: { credit_score: Infinity },
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => okJson(raw)));
    const report = await makeClient().fetchReport('case-123');
    expect(report.creditScore).toBeNull();
  });

  it('idVerified is true when only score=CLEAR (sub_score absent)', async () => {
    const raw = {
      id: 'case-123',
      created: '2026-08-21T10:00:00Z',
      overall_status: 'COMPLETE',
      checks: [
        {
          id: 'c1',
          type: 'IDENTITY_VERIFICATION_1',
          status: 'COMPLETE',
          score: 'CLEAR',
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => okJson(raw)));
    const report = await makeClient().fetchReport('case-123');
    expect(report.idVerified).toBe(true);
  });

  it('idVerified is true when only sub_score=VERIFIED (score absent)', async () => {
    const raw = {
      id: 'case-123',
      created: '2026-08-21T10:00:00Z',
      overall_status: 'COMPLETE',
      checks: [
        {
          id: 'c1',
          type: 'IDENTITY_VERIFICATION_1',
          status: 'COMPLETE',
          sub_score: 'VERIFIED',
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => okJson(raw)));
    const report = await makeClient().fetchReport('case-123');
    expect(report.idVerified).toBe(true);
  });

  it('strips multiple trailing slashes from baseUrl', async () => {
    const client = new CertnClient({
      baseUrl: 'https://api.sandbox.certn.co///',
      apiKey: 'certn-api-key',
      webhookSecret: WEBHOOK_SECRET,
    });
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.sandbox.certn.co/api/public/cases/case-123');
      return okJson({ id: 'case-123', overall_status: 'COMPLETE', checks: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    await client.fetchReport('case-123');
  });

  it('orders without tags when tags array is empty', async () => {
    const client = new CertnClient({
      baseUrl: BASE_URL,
      apiKey: 'certn-api-key',
      webhookSecret: WEBHOOK_SECRET,
      profileName: 'identity',
      tags: [],
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty('tags');
      return okJson({ id: 'case-notags', invite_link: 'https://invite' }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);
    await client.invite('jane@example.com');
  });

  it('orders without group when group is undefined', async () => {
    const client = new CertnClient({
      baseUrl: BASE_URL,
      apiKey: 'certn-api-key',
      webhookSecret: WEBHOOK_SECRET,
      profileName: 'identity',
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty('group');
      return okJson({ id: 'case-nogroup', invite_link: 'https://invite' }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);
    await client.invite('jane@example.com');
  });

  it('orders without applicant_language when applicantLanguage is undefined', async () => {
    const client = new CertnClient({
      baseUrl: BASE_URL,
      apiKey: 'certn-api-key',
      webhookSecret: WEBHOOK_SECRET,
      profileName: 'identity',
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty('applicant_language');
      return okJson({ id: 'case-nolang', invite_link: 'https://invite' }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);
    await client.invite('jane@example.com');
  });

  it('invite throws when response has no id field at all', async () => {
    const fetchMock = vi.fn(async () => okJson({ invite_link: 'https://invite' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().invite('jane@example.com')).rejects.toThrow('missing id/invite_link');
  });

  it('invite throws when response has no invite_link field at all', async () => {
    const fetchMock = vi.fn(async () => okJson({ id: 'case-1' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().invite('jane@example.com')).rejects.toThrow('missing id/invite_link');
  });

  it('parseWebhook maps CASE_STATUS_CHANGED with non-complete non-cancelled status to in_progress', async () => {
    const rawBody = JSON.stringify({
      event_id: 'event-ip',
      event_type: 'CASE_STATUS_CHANGED',
      object_id: 'case-123',
      case_status: 'IN_PROGRESS',
    });
    const result = await makeClient().parseWebhook(
      JSON.parse(rawBody),
      { 'X-Signature': signature(rawBody) },
      rawBody
    );
    expect(result).toMatchObject({
      applicationId: 'case-123',
      status: 'in_progress',
      eventId: 'event-ip',
    });
    expect(result.actionRequired).toBeFalsy();
  });

  it('request error includes HTTP method for GET requests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))
    );
    await expect(makeClient().fetchReport('case-404')).rejects.toThrow(
      'Certn request failed: GET'
    );
  });
});

describe('createCertnConfigFromEnv – additional tests', () => {
  it('throws on missing CERTN_WEBHOOK_SECRET', () => {
    process.env.CERTN_API_KEY = 'api-key';
    delete process.env.CERTN_WEBHOOK_SECRET;
    expect(() => createCertnConfigFromEnv()).toThrow('CERTN_WEBHOOK_SECRET');
  });

  it('sets group to undefined when CERTN_GROUP is not set', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    delete process.env.CERTN_GROUP;
    const config = createCertnConfigFromEnv();
    expect(config.group).toBeUndefined();
  });

  it('sets applicantLanguage to undefined when CERTN_APPLICANT_LANGUAGE is not set', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    delete process.env.CERTN_APPLICANT_LANGUAGE;
    const config = createCertnConfigFromEnv();
    expect(config.applicantLanguage).toBeUndefined();
  });

  it('returns empty tags when CERTN_TAGS is not set', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    delete process.env.CERTN_TAGS;
    const config = createCertnConfigFromEnv();
    expect(config.tags).toEqual([]);
  });

  it('filters out non-string entries from CERTN_TAGS', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    process.env.CERTN_TAGS = JSON.stringify(['valid', 123, null, true, 'also-valid']);
    const config = createCertnConfigFromEnv();
    expect(config.tags).toEqual(['valid', 'also-valid']);
  });

  it('returns empty tags for non-array JSON in CERTN_TAGS', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    process.env.CERTN_TAGS = JSON.stringify({ not: 'an-array' });
    const config = createCertnConfigFromEnv();
    expect(config.tags).toEqual([]);
  });

  it('uses default profile when CERTN_PROFILE is not set', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    delete process.env.CERTN_PROFILE;
    const config = createCertnConfigFromEnv();
    expect(config.profileName).toBe('identity');
  });

  it('uses custom profile when CERTN_PROFILE is set', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    process.env.CERTN_PROFILE = 'credit';
    const config = createCertnConfigFromEnv();
    expect(config.profileName).toBe('credit');
  });
});

describe('CertnWebhookSignatureError', () => {
  it('has the correct default message', () => {
    const err = new CertnWebhookSignatureError();
    expect(err.message).toBe('Invalid Certn webhook signature');
  });

  it('has the correct name', () => {
    const err = new CertnWebhookSignatureError();
    expect(err.name).toBe('CertnWebhookSignatureError');
  });

  it('has statusCode 401', () => {
    const err = new CertnWebhookSignatureError();
    expect(err.statusCode).toBe(401);
  });

  it('accepts a custom message', () => {
    const err = new CertnWebhookSignatureError('custom');
    expect(err.message).toBe('custom');
  });
});

describe('verifySecret', () => {
  it('returns false for undefined provided value', () => {
    expect(verifySecret(undefined, 'secret')).toBe(false);
  });

  it('returns false for empty string provided value', () => {
    expect(verifySecret('', 'secret')).toBe(false);
  });

  it('returns false for empty expected value', () => {
    expect(verifySecret('secret', '')).toBe(false);
  });

  it('returns true for matching values', () => {
    expect(verifySecret('my-secret', 'my-secret')).toBe(true);
  });

  it('returns false for non-matching values of same length', () => {
    expect(verifySecret('my-secret', 'my-Secret')).toBe(false);
  });

  it('returns false for non-matching values of different length', () => {
    expect(verifySecret('short', 'much-longer-value')).toBe(false);
  });
});

describe('safeEqual', () => {
  it('returns true for equal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('returns false for different length strings', () => {
    expect(safeEqual('abc', 'ab')).toBe(false);
    expect(safeEqual('ab', 'abc')).toBe(false);
  });
});

describe('createCertnClient', () => {
  it('returns a CertnClient instance', () => {
    const client = createCertnClient({
      baseUrl: BASE_URL,
      apiKey: 'certn-api-key',
      webhookSecret: WEBHOOK_SECRET,
    });
    expect(client).toBeInstanceOf(CertnClient);
  });
});

describe('CertnClient – final mutation-killing tests', () => {
  it('parseWebhook skips the first header when the key does not match', async () => {
    const rawBody = JSON.stringify({
      event_id: 'event-1',
      event_type: 'CASE_REPORT_READY',
      object_id: 'case-123',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ id: 'case-123', overall_status: 'COMPLETE', checks: [] }))
    );
    const hex = signature(rawBody);
    const result = await makeClient().parseWebhook(
      JSON.parse(rawBody),
      { 'Other-Header': 'garbage', 'x-signature': hex },
      rawBody
    );
    expect(result).toMatchObject({ status: 'completed' });
  });

  it('parseWebhook drops an empty event_id', async () => {
    const rawBody = JSON.stringify({
      event_id: '',
      event_type: 'CASE_REPORT_READY',
      object_id: 'case-123',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ id: 'case-123', overall_status: 'COMPLETE', checks: [] }))
    );
    const hex = signature(rawBody);
    const result = await makeClient().parseWebhook(
      JSON.parse(rawBody),
      { 'X-Signature': hex },
      rawBody
    );
    expect(result.eventId).toBeUndefined();
  });

  it('verifyWebhook accepts a valid signature', () => {
    const rawBody = 'test-body';
    const hmac = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    expect(makeClient().verifyWebhook(hmac, rawBody)).toBe(true);
  });

  it('verifyWebhook rejects an invalid signature', () => {
    expect(makeClient().verifyWebhook('wrong', 'test-body')).toBe(false);
  });

  it('fetchReport ignores a non-array checks value', async () => {
    const raw = {
      id: 'case-123',
      created: '2026-08-21T10:00:00Z',
      overall_status: 'COMPLETE',
      checks: 'not-an-array',
    };
    vi.stubGlobal('fetch', vi.fn(async () => okJson(raw)));
    const report = await makeClient().fetchReport('case-123');
    expect(report.reportJsonb.checks).toEqual([]);
  });

  it('fetchReport treats a whitespace-only credit_score as null', async () => {
    const raw = {
      id: 'case-123',
      created: '2026-08-21T10:00:00Z',
      overall_status: 'COMPLETE',
      checks: [
        {
          id: 'c1',
          type: 'CREDIT_REPORT_1',
          status: 'COMPLETE',
          output_claims: { credit_score: '   ' },
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => okJson(raw)));
    const report = await makeClient().fetchReport('case-123');
    expect(report.creditScore).toBeNull();
  });

  it('request preserves custom headers and defaults to GET', async () => {
    const client = makeClient();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ 'X-Custom': 'custom-value' });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      (client as any).request('/api/public/cases/404', { headers: { 'X-Custom': 'custom-value' } })
    ).rejects.toThrow('Certn request failed: GET /api/public/cases/404: HTTP 404');
  });

});

describe('createCertnConfigFromEnv – value preservation', () => {
  it('preserves a non-empty CERTN_GROUP', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    process.env.CERTN_GROUP = 'finance';
    const config = createCertnConfigFromEnv();
    expect(config.group).toBe('finance');
  });

  it('preserves a non-empty CERTN_APPLICANT_LANGUAGE', () => {
    process.env.CERTN_API_KEY = 'api-key';
    process.env.CERTN_WEBHOOK_SECRET = 'webhook-secret';
    process.env.CERTN_APPLICANT_LANGUAGE = 'fr-CA';
    const config = createCertnConfigFromEnv();
    expect(config.applicantLanguage).toBe('fr-CA');
  });
});
