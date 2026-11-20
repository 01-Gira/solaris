const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function validPubkey(value) { return typeof value === 'string' && PUBKEY.test(value); }
export function validSignature(value) { return typeof value === 'string' && SIG.test(value); }

export function parseLogsNotification(payload, subscriptions) {
  if (payload?.method !== 'logsNotification') return null;
  const poolAddress = subscriptions.get(payload?.params?.subscription);
  const value = payload?.params?.result?.value;
  const slot = payload?.params?.result?.context?.slot;
  if (!poolAddress || !validSignature(value?.signature) || !Number.isSafeInteger(slot) || slot < 0) return null;
  return {
    poolAddress,
    signature: value.signature,
    slot,
    error: value.err ?? null,
    logs: Array.isArray(value.logs) ? value.logs.filter(x => typeof x === 'string').slice(0, 1000) : [],
    source: 'live'
  };
}

export function parseSignatureHistory(rows, poolAddress) {
  if (!Array.isArray(rows)) throw new Error('getSignaturesForAddress returned non-array');
  return rows.filter(row => validSignature(row?.signature) && Number.isSafeInteger(row?.slot))
    .map(row => ({
      poolAddress,
      signature: row.signature,
      slot: row.slot,
      error: row.err ?? null,
      logs: [],
      source: 'backfill'
    })).reverse(); // RPC returns newest first; record oldest first.
}

// These are raw SPL token account balance changes, not swaps, wallet trades, or USD prices.
export function extractTokenBalanceChanges(tx) {
  const meta = tx?.meta;
  if (!meta) return [];
  const lookup = new Map();
  const ingest = (rows, side) => {
    for (const b of Array.isArray(rows) ? rows : []) {
      if (!Number.isSafeInteger(b?.accountIndex) || b.accountIndex < 0 || !validPubkey(b?.mint)) continue;
      const amount = b?.uiTokenAmount?.amount;
      if (typeof amount !== 'string' || !/^\d+$/.test(amount)) continue;
      const key = `${b.accountIndex}:${b.mint}`;
      const existing = lookup.get(key) || {
        accountIndex: b.accountIndex, mint: b.mint, owner: null,
        programId: null, decimals: null, pre: '0', post: '0'
      };
      if (typeof b.owner === 'string' && validPubkey(b.owner)) existing.owner = b.owner;
      if (typeof b.programId === 'string' && validPubkey(b.programId)) existing.programId = b.programId;
      if (Number.isInteger(b.uiTokenAmount.decimals)) existing.decimals = b.uiTokenAmount.decimals;
      existing[side] = amount;
      lookup.set(key, existing);
    }
  };
  ingest(meta.preTokenBalances, 'pre');
  ingest(meta.postTokenBalances, 'post');
  return [...lookup.values()].map(x => ({ ...x, deltaRaw: (BigInt(x.post) - BigInt(x.pre)).toString() }));
}
