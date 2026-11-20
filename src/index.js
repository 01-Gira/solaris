import { getConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { startServer } from './server.js';
import { startCollector } from './collector.js';

const config = getConfig();
const pool = createPool(config.dbUrl);
await migrate(pool);
const server = await startServer(pool, config);
console.log(JSON.stringify({ kind: 'started', port: config.port, source: 'geckoterminal',
  collectorEnabled: config.collectorEnabled, readOnly: true }));
const controller = new AbortController();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  controller.abort();
  server.close();
  // Stop after active transaction completes; allow a brief drain.
  await pool.end();
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
if (config.collectorEnabled) {
  startCollector(pool, config, controller).catch(err => {
    console.error(JSON.stringify({ kind: 'collector_fatal', error: String(err) }));
    process.exitCode = 1;
    stop();
  });
}
