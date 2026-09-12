/**
 * Invite-and-report for `@clocklobster/certn-client`.
 *
 * Runs offline: synthetic config plus a mocked `fetch` covering the invite
 * shape (POST /api/public/cases/order/) and the report shapes (GET case
 * detail for `fetchReport`, plus the generate-report / report-file poll /
 * PDF download chain for `fetchPdf`). No network calls and no credentials
 * needed — the mock restores the original `fetch` when finished.
 *
 * Run with any TypeScript runner, e.g. `npx tsx examples/invite-and-report.ts`.
 */
import { createCertnClient, CERTN_SANDBOX_BASE_URL } from '../src/index.js';

const CASE_ID = 'case-123';
const REPORT_FILE_ID = 'file-456';
const PDF_URL = 'https://cdn.certn.co/reports/file-456.pdf';
const PDF_BYTES = Buffer.from('%PDF-1.4 synthetic report bytes');

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installMockFetch(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    const method = init?.method ?? 'GET';
    if (href.endsWith('/api/public/cases/order/') && method === 'POST') {
      return okJson({ id: CASE_ID, invite_link: `https://app.certn.co/invite/${CASE_ID}` }, 201);
    }
    if (href.endsWith(`/api/public/cases/${CASE_ID}`) && method === 'GET') {
      return okJson({
        id: CASE_ID,
        short_id: 'C123',
        created: '2026-08-21T10:00:00Z',
        modified: '2026-08-21T11:00:00Z',
        overall_status: 'COMPLETE',
        overall_score: 'CLEAR',
        checks: [
          {
            id: 'check-credit',
            short_id: 'CC1',
            type: 'CREDIT_REPORT_1',
            status: 'COMPLETE',
            output_claims: { credit_score: 720 },
          },
          {
            id: 'check-identity',
            short_id: 'CI1',
            type: 'IDENTITY_VERIFICATION_1',
            status: 'COMPLETE',
            id_verified: true,
          },
        ],
      });
    }
    if (href.endsWith(`/api/public/cases/${CASE_ID}/generate-report/`) && method === 'POST') {
      return okJson({ case_report_file_id: REPORT_FILE_ID });
    }
    if (href.endsWith(`/api/public/cases/report-files/${REPORT_FILE_ID}/`)) {
      return okJson({ status: 'COMPLETE', pdf_url: PDF_URL });
    }
    if (href === PDF_URL) {
      return new Response(PDF_BYTES, { status: 200 });
    }
    throw new Error(`Unexpected offline request: ${method} ${href}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const restoreFetch = installMockFetch();
try {
  const client = createCertnClient({
    baseUrl: CERTN_SANDBOX_BASE_URL,
    apiKey: 'sandbox-api-key',
    webhookSecret: 'sandbox-webhook-secret',
  });

  const invite = await client.invite('jane@example.com', 'credit');
  if (invite.purchaseToken !== CASE_ID || !invite.secureLink) {
    throw new Error(`Unexpected invite result: ${JSON.stringify(invite)}`);
  }

  const report = await client.fetchReport(invite.purchaseToken);
  if (report.creditScore !== 720 || report.idVerified !== true) {
    throw new Error(`Unexpected report result: ${JSON.stringify(report.reportJsonb)}`);
  }

  const pdf = await client.fetchPdf(invite.purchaseToken);
  if (pdf.length === 0) {
    throw new Error('Expected non-empty PDF bytes');
  }

  console.log(
    `invite-and-report: success — invite (${invite.purchaseToken}), ` +
      `fetchReport (creditScore ${report.creditScore}), ` +
      `fetchPdf (${pdf.length} bytes) all ran offline`
  );
} finally {
  restoreFetch();
}
