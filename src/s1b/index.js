import { createPool, migrate } from '../db.js';
import { getS1bConfig } from './config.js';
import { migrateS1b, setHealth } from './store.js';
import { runS1b } from './worker.js';

const config = getS1bConfig();
const db = createPool(config.dbUrl);
await migrate(db); // Existing S1a tables first; all IF NOT EXISTS.
await migrateS1b(db);
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
console.log(JSON.stringify({ kind: 's1b_started', at: new Date().toISOString(), readOnly: true,
  maxPools: config.maxPools, configured: true, wallet: false, trading: false }));
try { await runS1b(db, config, controller.signal); }
finally {
  try { await setHealth(db, 'stopped', 0); } catch { /* DB may be unavailable */ }
  await db.end();
}
