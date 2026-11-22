// Local / CI entry: `npm run migrate` with DB_* set (see .env.example).
import * as path from 'node:path';
import { handler } from '../lambdas/migrate';
import { db } from '../lambdas/_common/db';

process.env.MIGRATIONS_DIR ??= path.join(__dirname, '..', '..', 'sql');
handler()
  .then((r) => { console.log(JSON.stringify(r.data)); return db.close(); })
  .catch((err) => { console.error(String(err)); process.exitCode = 1; return db.close(); });
