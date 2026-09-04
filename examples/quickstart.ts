/**
 * Quickstart for `@clocklobster/certn-client`.
 *
 * Runs offline: client construction plus webhook signature verification with
 * synthetic values. Live calls (`invite`, `fetchReport`, `fetchPdf`) need a
 * sandbox API key and network access — see the README "Quick start".
 *
 * Run with any TypeScript runner, e.g. `npx tsx examples/quickstart.ts`.
 */
import { createHmac } from 'node:crypto';
import { createCertnClient, CERTN_SANDBOX_BASE_URL } from '../src/index.js';

const webhookSecret = 'sandbox-webhook-secret';

const client = createCertnClient({
  baseUrl: CERTN_SANDBOX_BASE_URL,
  apiKey: 'sandbox-api-key',
  webhookSecret,
});

// Verify an X-Signature webhook the same way Certn signs it
// (HMAC-SHA256 over the raw body).
const rawBody = JSON.stringify({ object_id: 'case-123', event_type: 'CASE_REPORT_READY' });
const signature = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

console.log('valid signature:', client.verifyWebhook(signature, rawBody)); // true
console.log('tampered body:', client.verifyWebhook(signature, `${rawBody} `)); // false

// Live calls (require network + CERTN_API_KEY):
// const { purchaseToken, secureLink } = await client.invite('jane@example.com', 'credit');
// const report = await client.fetchReport(purchaseToken);
// console.log(report.creditScore, report.idVerified);
// const pdf = await client.fetchPdf(purchaseToken);
