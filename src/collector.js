import { startRun, finishRun, savePage, pickWatchlist } from './db.js';
import { fetchNewPools, fetchMultiPools } from './gecko.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function pollOnce(db, config, fetchPage = fetchNewPools) {
  const runId = await startRun(db);
  const seenThisRun = new Set();
  const counters = { pages: 0, seen: 0, newPools: 0, duplicates: 0, malformed: 0 };
  let status = 'success';
  let errorText = null;
  let retryAfterMs = 0;
  try {
    for (let pageNum = 1; pageNum <= config.pagesPerPoll; pageNum++) {
      const response = await fetchPage(config.apiBase, pageNum, config.fetchTimeoutMs);
      if (response.malformed?.length) counters.malformed += response.malformed.length;
      const result = await savePage(db, runId, response, seenThisRun);
      counters.pages++;
      counters.seen += result.saved;
      counters.newPools += result.newlyDiscovered;
      counters.duplicates += result.duplicates;
    }
    // Observe a bounded set of pools that have dropped out of the newest-page list.
    // This is NOT exhaustive historical price collection; one public API request per cycle.
    if (config.watchlistSize > 0) {
      const addresses = await pickWatchlist(db, seenThisRun, config.watchlistSize);
      if (addresses.length > 0) {
        const response = await fetchMultiPools(config.apiBase, addresses, config.fetchTimeoutMs);
        if (response.malformed?.length) counters.malformed += response.malformed.length;
        const result = await savePage(db, runId, response, seenThisRun);
        counters.pages++;
        counters.seen += result.saved;
        counters.newPools += result.newlyDiscovered;
        counters.duplicates += result.duplicates;
      }
    }
  } catch (error) {
    status = counters.pages > 0 ? 'partial' : 'failed';
    errorText = error?.stack || String(error);
    retryAfterMs = error?.retryAfterMs || 0;
  } finally {
    const details = errorText ? `${errorText}\nmalformed=${counters.malformed}` : (counters.malformed ? `malformed=${counters.malformed}` : null);
    await finishRun(db, runId, status, counters, details);
  }
  return { runId, status, counters, error: errorText, retryAfterMs };
}

export async function startCollector(db, config, controller) {
  let backoff = 0;
  while (!controller.signal.aborted) {
    const startedAt = Date.now();
    let waitMs = config.pollIntervalMs;
    try {
      const result = await pollOnce(db, config);
      if (result.status === 'success') {
        backoff = 0;
      } else {
        backoff = Math.min(600_000, backoff ? backoff * 2 : 30_000);
        waitMs = Math.max(waitMs, backoff, result.retryAfterMs || 0);
      }
      console.log(JSON.stringify({ kind: 'poll', at: new Date().toISOString(), ...result, error: result.error?.slice(0, 500) }));
    } catch (error) {
      backoff = Math.min(600_000, backoff ? backoff * 2 : 30_000);
      waitMs = Math.max(waitMs, backoff);
      console.error(JSON.stringify({ kind: 'poll_crash', at: new Date().toISOString(), error: String(error) }));
    }
    // Respect interval from cycle start, apply rate-limit/server backoff on top.
    waitMs = Math.max(0, waitMs - (Date.now() - startedAt));
    // Allow shutdown to interrupt the sleep quickly (but no tight busy loop).
    for (let remaining = waitMs; remaining > 0 && !controller.signal.aborted;) {
      const chunk = Math.min(1000, remaining);
      await delay(chunk);
      remaining -= chunk;
    }
  }
}
