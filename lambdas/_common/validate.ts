/**
 * Small input helpers. Everything a handler reads from `path`, `query` or
 * `body` goes through one of these so a malformed value is a 400 with the
 * field named, never a TypeError deep inside an upstream call.
 */

import { ValidationError } from './errors';

type Bag = Record<string, unknown> | undefined;

export function requiredString(bag: Bag, key: string, max = 200): string {
  const v = optionalString(bag, key, max);
  if (!v) throw new ValidationError('Validation failed', `'${key}' is required`);
  return v;
}

export function optionalString(bag: Bag, key: string, max = 200): string | undefined {
  const raw = bag?.[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const v = Array.isArray(raw) ? String(raw[0]) : String(raw);
  if (v.length > max) throw new ValidationError('Validation failed', `'${key}' must be at most ${max} characters`);
  return v;
}

export function optionalInt(bag: Bag, key: string, fallback: number, min = 0, max = 1_000_000): number {
  const raw = bag?.[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError('Validation failed', `'${key}' must be an integer between ${min} and ${max}`);
  }
  return n;
}

export function optionalBool(bag: Bag, key: string): boolean | undefined {
  const raw = bag?.[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const v = String(Array.isArray(raw) ? raw[0] : raw).toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new ValidationError('Validation failed', `'${key}' must be a boolean`);
}

export function requiredEnum<T extends string>(bag: Bag, key: string, values: readonly T[]): T {
  const v = requiredString(bag, key, 50);
  if (!values.includes(v as T)) {
    throw new ValidationError('Validation failed', `'${key}' must be one of ${values.join(', ')}`);
  }
  return v as T;
}

export function optionalEnum<T extends string>(bag: Bag, key: string, values: readonly T[]): T | undefined {
  const v = bag?.[key];
  if (v === undefined || v === null || v === '') return undefined;
  return requiredEnum(bag, key, values);
}

/** Comma-separated or array input → trimmed, de-duplicated, bounded list. */
export function stringList(bag: Bag, key: string, max = 200): string[] {
  const raw = bag?.[key];
  if (raw === undefined || raw === null || raw === '') return [];
  const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split(',');
  const out = [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
  if (out.length > max) throw new ValidationError('Validation failed', `'${key}' may list at most ${max} values`);
  return out;
}

export function bodyObject(body: unknown): Record<string, unknown> {
  if (body === null || body === undefined) return {};
  if (typeof body === 'string') {
    try {
      return bodyObject(JSON.parse(body));
    } catch {
      throw new ValidationError('Validation failed', "'body' is not valid JSON");
    }
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Validation failed', "'body' must be an object");
  }
  return body as Record<string, unknown>;
}

/**
 * Free text a player or operator typed. Bounded, control characters stripped,
 * never trusted as markup by anything downstream.
 */
export function messageText(bag: Bag, key: string, max = 2000): string {
  const v = requiredString(bag, key, max);
  const clean = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!clean) throw new ValidationError('Validation failed', `'${key}' is empty`);
  return clean;
}
