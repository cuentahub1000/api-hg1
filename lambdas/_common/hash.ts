/**
 * Keyed hash of a national id. The raw number is sent to the provider when it
 * needs it and then dropped; only HMAC-SHA256(normalised id, DOCUMENT_HASH_KEY)
 * is stored, so a later entry can be compared without the platform ever
 * holding the id itself. Without a key nothing is hashed (and nothing stored).
 */

import { createHmac } from 'node:crypto';

export function documentHash(document: string | undefined, key: string | undefined): string | null {
  if (!document || !key) return null;
  const normalised = document.replace(/[^0-9a-z]/gi, '').toUpperCase();
  if (!normalised) return null;
  return createHmac('sha256', key).update(normalised).digest('hex');
}
