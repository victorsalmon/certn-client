/**
 * Constant-time secret comparison helpers.
 *
 * Webhook signature verification must compare digests in constant time — a
 * plain `===`/`!==` on secret strings leaks timing information, and an unset
 * expected secret must fail closed (never match an empty input).
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison (lengths differ → not equal).
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True when `provided` is a non-empty string equal to `expected` (constant-time). */
export function verifySecret(provided: string | undefined, expected: string): boolean {
  if (provided === undefined || provided.length === 0) return false;
  if (expected.length === 0) return false;
  return safeEqual(provided, expected);
}
