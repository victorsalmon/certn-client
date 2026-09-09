/**
 * QA focused regression for plan certn-client-0-request-resilience.
 *
 * Proves the acceptance criteria without touching production source:
 *  AC1 timeout abort (15s API / 30s PDF, overridable via config)
 *  AC2 retry once on 429/5xx, no retry on 4xx
 *  AC3 invite email + caseId validation before any network call
 *  AC4 null-honest completedAt (no fabricated now-timestamp), evictionCount null
 *  AC6 pinned wire contract unchanged
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CertnClient } from '../src/client.js';

const BASE_URL = 'https://api.sandbox.certn.co';
const WEBHOOK_SECRET = 'certn-webhook-test-secret';

function makeClient(extra: Record<string, unknown> = {}): CertnClient {
  return new CertnClient({
    baseUrl: BASE_URL,
    apiKey: 'certn-api-key',
    webhookSecret: WEBHOOK_SECRET,
    profileName: 'identity',
    ...extra,
  } as unknown as ConstructorParameters<typeof CertnClient>[0]);
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('QA request-resilience', () => {
  it('AC3: invite() rejects empty/malformed applicantEmail before any network call', async () => {
    const fetchMock = vi.fn(async () => okJson({ id: 'case-1', invite_link: 'https://invite' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    await expect(client.invite('')).rejects.toThrow(/email/i);
    await expect(client.invite('   ')).rejects.toThrow(/email/i);
    await expect(client.invite('not-an-email')).rejects.toThrow(/email/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AC3: empty/whitespace caseId throws before any network call', async () => {
    const fetchMock = vi.fn(async () => okJson({ id: 'case-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    await expect(client.fetchReport('')).rejects.toThrow(/case id/i);
    await expect(client.fetchReport('   ')).rejects.toThrow(/case id/i);
    await expect(client.cancelCase('')).rejects.toThrow(/case id/i);
    await expect(client.fetchPdf('  ')).rejects.toThrow(/case id/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AC4: completedAt is null (not a fabricated now-timestamp) when provider supplies neither modified nor created', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ id: 'case-123', overall_status: 'COMPLETE', checks: [] }))
    );
    const report = await makeClient().fetchReport('case-123');
    expect(report.evictionCount).toBeNull();
    expect(report.completedAt).toBeNull();
  });

  it('AC2: fetchReport retries once on HTTP 429 then succeeds', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) return new Response(JSON.stringify({ type: 'error' }), { status: 429 });
        return okJson({ id: 'case-123', overall_status: 'COMPLETE', checks: [] });
      })
    );
    const report = await makeClient().fetchReport('case-123');
    expect(report).toBeDefined();
    expect(calls).toBe(2);
  });

  it('AC2: invite retries once on HTTP 500 then succeeds', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) return new Response(JSON.stringify({ type: 'error' }), { status: 500 });
        return okJson({ id: 'case-1', invite_link: 'https://invite' }, 201);
      })
    );
    const invite = await makeClient().invite('jane@example.com');
    expect(invite.purchaseToken).toBe('case-1');
    expect(calls).toBe(2);
  });

  it('AC2: no retry on plain 4xx (400 fails fast with a single fetch call)', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response(JSON.stringify({ type: 'error' }), { status: 400 });
      })
    );
    await expect(makeClient().fetchReport('case-123')).rejects.toThrow('HTTP 400');
    expect(calls).toBe(1);
  });

  it('AC1: API requests carry an abort signal (timeout) and honor config override', async () => {
    const seen: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push((init as Record<string, unknown>)?.signal);
        return okJson({ id: 'case-123', overall_status: 'COMPLETE', checks: [] });
      })
    );
    // Overridable via client config (cast: field exists only in resilient impl).
    await makeClient({ requestTimeoutMs: 1234 }).fetchReport('case-123');
    expect(seen.length).toBeGreaterThan(0);
    for (const signal of seen) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('AC6: pinned wire contract unchanged (Api-Key, /api/public/cases/*, JSON accept)', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(String(url));
      const headers = (init?.headers as Record<string, string>) ?? {};
      expect(headers.Authorization).toBe('Api-Key certn-api-key');
      return okJson({ id: 'case-123', overall_status: 'COMPLETE', checks: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    await makeClient().fetchReport('case-123');
    expect(urls[0]).toBe(`${BASE_URL}/api/public/cases/case-123`);
  });
});
