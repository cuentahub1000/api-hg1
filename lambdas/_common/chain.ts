/**
 * Chain-prefix scoping — the multi-tenancy boundary, derived exactly as
 * api-wallet derives it:
 *     fullChain = chain !== '' ? `${chain}-${partyId}` : partyId
 *
 * A party's `chain` holds its ancestors joined by '-', so a party sits inside
 * the caller's subtree iff its chain starts with the caller's fullChain. Every
 * operator-facing handler must run its targets through `isDescendant`.
 */

export function fullChainOf(chain: string, partyId: string): string {
  return chain ? `${chain}-${partyId}` : partyId;
}

/** True when `chain` sits inside the caller's subtree (or is the caller itself). */
export function isDescendant(chain: string | null | undefined, fullChain: string): boolean {
  if (!chain || !fullChain) return false;
  return chain === fullChain || chain.startsWith(`${fullChain}-`);
}

/** The root tenant of a chain: its first segment. */
export function rootOf(chain: string): string {
  const idx = chain.indexOf('-');
  return idx === -1 ? chain : chain.slice(0, idx);
}
