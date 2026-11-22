/**
 * `<env>-hg-migrate` — applies `sql/*.sql` in name order, once each
 * (tracked in `schema_migrations`). Not an HTTP route: invoked by the deploy
 * script after `cdk deploy`, or by `npm run migrate` locally. The SQL files
 * are bundled next to the handler as text.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { db } from '../_common/db';
import { log } from '../_common/logger';

export interface MigrateResult { applied: string[]; skipped: string[] }

export async function handler(): Promise<{ ok: true; data: MigrateResult }> {
  const dir = process.env.MIGRATIONS_DIR ?? path.join(__dirname, 'sql');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    if (done.has(f)) { skipped.push(f); continue; }
    const sql = readFileSync(path.join(dir, f), 'utf8');
    await db.transaction(async (tx) => {
      await tx.execute(sql);
      await tx.execute('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    log.info('migration applied', { file: f });
    applied.push(f);
  }
  return { ok: true, data: { applied, skipped } };
}
