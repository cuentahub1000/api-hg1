/**
 * Postgres access. Two connections, one client each, reused across warm
 * invocations (a Lambda container serves one request at a time):
 *
 *   db        the payments database — this service's own store (read/write)
 *             DB_HOST DB_PORT DB_NAME, DB_SECRET_ARN (or DB_USER/DB_PASSWORD locally)
 *   auth      the api-auth database, READ ONLY, for the per-call session check
 *             (`_common/session.ts`: the `Session` table lives there)
 *             AUTH_DB_HOST AUTH_DB_PORT AUTH_DB_NAME,
 *             AUTH_DB_SECRET_ARN (or AUTH_DB_USER/AUTH_DB_PASSWORD locally)
 *   security  the api-security database, READ ONLY, for the operator feature
 *             check (`_common/permissions.ts`: User/Role/Feature)
 *             SECURITY_DB_HOST SECURITY_DB_PORT SECURITY_DB_NAME,
 *             SECURITY_DB_SECRET_ARN (or SECURITY_DB_USER/SECURITY_DB_PASSWORD locally)
 *
 *   DB_SSL    `disable` turns TLS off for both; anything else keeps it on
 *
 * The wallet database is never one of these: the wallet is reached only through
 * its API (`_domain/wallet.ts`).
 *
 * `numeric` columns come back as strings and are converted by the domain
 * layer (`money()`); `int8` stays a string and nothing here uses it.
 */

import { Client, types, type QueryResultRow } from 'pg';
import { log } from './logger';

// timestamptz -> ISO string, not a Date: the envelope would stringify it
// anyway and a string compares/serialises predictably.
types.setTypeParser(1184, (v: string) => new Date(v).toISOString());

export type Sql = string;
export type Params = readonly unknown[];

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(sql: Sql, params?: Params): Promise<T[]>;
  one<T extends QueryResultRow = QueryResultRow>(sql: Sql, params?: Params): Promise<T | null>;
  execute(sql: Sql, params?: Params): Promise<number>;
}

type Credentials = { username: string; password: string };

/** Environment variable names of one connection. */
interface Spec { host: string; port: string; database: string; secret: string; user: string; password: string }

const PAYMENTS: Spec = { host: 'DB_HOST', port: 'DB_PORT', database: 'DB_NAME', secret: 'DB_SECRET_ARN', user: 'DB_USER', password: 'DB_PASSWORD' };
const AUTH: Spec = { host: 'AUTH_DB_HOST', port: 'AUTH_DB_PORT', database: 'AUTH_DB_NAME', secret: 'AUTH_DB_SECRET_ARN', user: 'AUTH_DB_USER', password: 'AUTH_DB_PASSWORD' };
const SECURITY: Spec = { host: 'SECURITY_DB_HOST', port: 'SECURITY_DB_PORT', database: 'SECURITY_DB_NAME', secret: 'SECURITY_DB_SECRET_ARN', user: 'SECURITY_DB_USER', password: 'SECURITY_DB_PASSWORD' };

function checkSpec(spec: Spec, what: string): void {
  const missing = [spec.host, spec.port, spec.database].filter((n) => !process.env[n]);
  if (!process.env[spec.secret] && !(process.env[spec.user] && process.env[spec.password])) missing.push(spec.secret);
  if (missing.length > 0) throw new Error(`${what} database environment variables are not set: ${missing.join(', ')}`);
  const port = Number(process.env[spec.port]);
  if (!Number.isFinite(port) || port <= 0) throw new Error(`${spec.port} is not a port number: ${process.env[spec.port]}`);
}

/** The payments database variables (the HTTP runtime checks them at start). */
export function checkEnv(): void { checkSpec(PAYMENTS, 'payments'); }
/** The api-auth and api-security database variables (both needed for the per-call checks). */
export function checkSecurityEnv(): void { checkSpec(AUTH, 'auth'); checkSpec(SECURITY, 'security'); }

const credsCache = new Map<string, Promise<Credentials>>();

function credentials(spec: Spec): Promise<Credentials> {
  const user = process.env[spec.user], password = process.env[spec.password];
  if (user && password) return Promise.resolve({ username: user, password });
  const secretId = process.env[spec.secret]!;
  let cached = credsCache.get(secretId);
  if (!cached) {
    cached = (async () => {
      const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
      const res = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
      if (!res.SecretString) throw new Error(`secret ${secretId} has no SecretString`);
      const parsed = JSON.parse(res.SecretString) as Partial<Credentials>;
      if (!parsed.username || !parsed.password) throw new Error(`secret ${secretId} is missing username/password`);
      return { username: parsed.username, password: parsed.password };
    })().catch((err) => {
      credsCache.delete(secretId);
      throw err;
    });
    credsCache.set(secretId, cached);
  }
  return cached;
}

class Connection implements Queryable {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;

  constructor(private readonly spec: Spec, private readonly what: string) {}

  /** True when the connection variables are present (the check itself is `handle()`). */
  configured(): boolean {
    const e = process.env, s = this.spec;
    return Boolean(e[s.host] && e[s.port] && e[s.database] && (e[s.secret] || (e[s.user] && e[s.password])));
  }

  private async handle(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        checkSpec(this.spec, this.what);
        const { username, password } = await credentials(this.spec);
        const target = { db: this.what, host: process.env[this.spec.host], port: process.env[this.spec.port], database: process.env[this.spec.database], user: username };
        try {
          const client = new Client({
            host: process.env[this.spec.host],
            port: Number(process.env[this.spec.port]),
            database: process.env[this.spec.database],
            user: username,
            password,
            // Encrypted but unverified inside the VPC (RDS cert is not in Node's
            // trust store); `disable` only for a local Postgres without TLS.
            ssl: process.env.DB_SSL === 'disable' ? false : { rejectUnauthorized: false },
            connectionTimeoutMillis: 10_000,
          });
          client.on('error', (err) => {
            log.warn('connection error, will reconnect', { ...target, err: String(err) });
            this.client = undefined;
            this.connecting = undefined;
          });
          await client.connect();
          log.info('connected', target);
          this.client = client;
          return client;
        } catch (err) {
          log.error('connect failed', { ...target, err: String(err) });
          throw err;
        }
      })().catch((err) => {
        this.connecting = undefined;
        throw err;
      });
    }
    return this.connecting;
  }

  /** Which connection a log line is about: name, host and database. */
  private target(): Record<string, string | undefined> {
    return { db: this.what, host: process.env[this.spec.host], database: process.env[this.spec.database] };
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: Sql, params: Params = []): Promise<T[]> {
    const client = await this.handle();
    try {
      return (await client.query<T>(sql, params as unknown[])).rows;
    } catch (err) {
      log.error('query failed', { ...this.target(), sql: sql.replace(/\s+/g, ' ').slice(0, 200), err: String(err) });
      throw err;
    }
  }

  async one<T extends QueryResultRow = QueryResultRow>(sql: Sql, params: Params = []): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null;
  }

  async execute(sql: Sql, params: Params = []): Promise<number> {
    const client = await this.handle();
    try {
      return (await client.query(sql, params as unknown[])).rowCount ?? 0;
    } catch (err) {
      log.error('statement failed', { ...this.target(), sql: sql.replace(/\s+/g, ' ').slice(0, 200), err: String(err) });
      throw err;
    }
  }

  /** Run `fn` inside BEGIN/COMMIT; ROLLBACK on throw. */
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.handle();
    await client.query('BEGIN');
    try {
      const out = await fn(this);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection is gone */ }
      throw err;
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (c) await c.end().catch(() => undefined);
  }
}

export const db = new Connection(PAYMENTS, 'payments');
/** api-auth, read only: the `Session` table. Never written, never joined with payments data. */
export const auth = new Connection(AUTH, 'auth');
/** api-security, read only: User/Role/Feature. Never written, never joined with payments data. */
export const security = new Connection(SECURITY, 'security');
