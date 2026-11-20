import { createPool } from '../src/db.js';

// Explicit manual maintenance: never delete research data automatically.
// Example: docker compose exec recorder node scripts/prune.js --raw-days=7
const arg = process.argv.find(x => x.startsWith('--raw-days='));
if (!arg) throw new Error('Specify --raw-days=N. This deletes raw HTTP responses older than N days, irreversibly.');
const days = Number(arg.split('=')[1]);
if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('raw-days must be an integer between 1 and 3650');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
const db = createPool(process.env.DATABASE_URL);
try {
  const result = await db.query("DELETE FROM raw_responses WHERE fetched_at < now() - ($1 * interval '1 day')", [days]);
  console.log(`Deleted ${result.rowCount} raw HTTP responses older than ${days} days. Snapshots and pools preserved.`);
} finally { await db.end(); }
