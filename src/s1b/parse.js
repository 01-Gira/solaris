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
  if (!Array.isArray(meta?.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) return [];
  const keys=tx.transaction?.message?.accountKeys;
  const indexed = rows => {
    const lookup=new Map();
    for (const b of rows) {
      if (!Number.isInteger(b?.accountIndex) || b.accountIndex < 0 || b.accountIndex > 255 ||
          (Array.isArray(keys)&&b.accountIndex>=keys.length)) continue;
      lookup.set(b.accountIndex,lookup.has(b.accountIndex)?null:b);
    }
    return lookup;
  };
  const after=indexed(meta.postTokenBalances);
  const amount=value=>typeof value==='string'&&/^\d{1,20}$/.test(value)&&BigInt(value)<(1n<<64n);
  return [...indexed(meta.preTokenBalances)].flatMap(([accountIndex,p])=>{
    const q=after.get(accountIndex);
    if (!p || !q || !validPubkey(p.mint) || p.mint!==q.mint || p.owner!==q.owner || p.programId!==q.programId) return [];
    const pre=p.uiTokenAmount?.amount,post=q.uiTokenAmount?.amount,decimals=p.uiTokenAmount?.decimals;
    if (!amount(pre) || !amount(post) || !Number.isInteger(decimals) || decimals<0 || decimals>255 ||
        decimals!==q.uiTokenAmount?.decimals) return [];
    return [{accountIndex,mint:p.mint,owner:validPubkey(p.owner)?p.owner:null,
      programId:validPubkey(p.programId)?p.programId:null,decimals,pre,post,
      deltaRaw:(BigInt(post)-BigInt(pre)).toString()}];
  });
}
