/** Input readers shared by the payment handlers. */
import { ValidationError } from './errors';
import { optionalInt, optionalString, requiredEnum, requiredString, stringList } from './validate';
import { ALL_STATUSES, OPEN_STATUSES, type DestinationType, type Payer, type PaymentKind, type PaymentStatus } from '../_domain/types';
import type { ListFilter } from '../_domain/payments';

type Bag = Record<string, unknown> | undefined;

/** Positive amount with at most two decimals. */
/** The wallet account the payment is made on. Required: nothing is picked for the caller. */
export function accountId(bag: Bag): string {
  const v = bag?.accountId;
  const str = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(str)) throw new ValidationError('Validation failed', 'accountId is required');
  return str;
}

export function amount(bag: Bag, key = 'amount'): number {
  const raw = bag?.[key];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) throw new ValidationError('Validation failed', `'${key}' must be a positive amount`);
  if (Math.round(n * 100) !== n * 100 && Math.abs(Math.round(n * 100) / 100 - n) > 1e-9) {
    throw new ValidationError('Validation failed', `'${key}' may have at most two decimals`);
  }
  return Math.round(n * 100) / 100;
}

/** An optional national id (7–14 alphanumerics), hashed before storage. */
export function document(bag: Bag): string | undefined {
  const v = optionalString(bag, 'document', 20);
  if (v && !/^[0-9A-Za-z.\-]{7,20}$/.test(v)) throw new ValidationError('Validation failed', "'document' is not a valid id");
  return v;
}

export function payer(bag: Bag): Payer | undefined {
  const raw = bag?.payer;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('Validation failed', "'payer' must be an object");
  const p = raw as Record<string, unknown>;
  const document = optionalString(p, 'document', 20);
  if (document && !/^\d{7,14}$/.test(document)) throw new ValidationError('Validation failed', "'payer.document' must be 7 to 14 digits");
  const email = optionalString(p, 'email', 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Validation failed', "'payer.email' is not an email");
  const name = optionalString(p, 'name', 120);
  return document || email || name ? { document, email, name } : undefined;
}

export function destination(bag: Bag): { type: DestinationType; value: string; holderName?: string } {
  const raw = bag?.destination;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('Validation failed', "'destination' is required");
  const d = raw as Record<string, unknown>;
  const type = requiredEnum(d, 'type', ['cbu', 'cvu'] as const);
  const value = requiredString(d, 'value', 40).replace(/\D/g, '');
  if (value.length !== 22) throw new ValidationError('Validation failed', "'destination.value' must have 22 digits");
  const holderName = optionalString(d, 'holderName', 120);
  return { type, value, holderName };
}

export function listFilter(query: Bag, defaults: { limit: number; max: number }): ListFilter {
  const kind = optionalString(query, 'kind', 20) as PaymentKind | undefined;
  if (kind && kind !== 'deposit' && kind !== 'withdrawal') throw new ValidationError('Validation failed', "'kind' must be deposit or withdrawal");
  // `open` = every non-final status; `all` (or nothing) = no status filter.
  const statuses = stringList(query, 'status', 20).filter((s) => s !== 'all').flatMap((s) => (s === 'open' ? [...OPEN_STATUSES] : [s])) as PaymentStatus[];
  for (const s of statuses) if (!ALL_STATUSES.includes(s)) throw new ValidationError('Validation failed', `unknown status '${s}'`);
  const from = optionalString(query, 'from', 40);
  const to = optionalString(query, 'to', 40);
  for (const [k, v] of [['from', from], ['to', to]] as const) {
    if (v && Number.isNaN(Date.parse(v))) throw new ValidationError('Validation failed', `'${k}' must be an ISO date`);
  }
  return {
    kind,
    statuses: statuses.length ? [...new Set(statuses)] : undefined,
    partyId: optionalString(query, 'partyId', 64),
    accountId: optionalString(query, 'accountId', 64),
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(to).toISOString() : undefined,
    limit: optionalInt(query, 'limit', defaults.limit, 1, defaults.max),
    cursor: optionalString(query, 'cursor', 300),
  };
}

export function paymentId(path: Bag): string {
  const id = requiredString(path, 'id', 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ValidationError('Validation failed', "'id' is not a payment id");
  return id.toLowerCase();
}
