const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58Index = new Map(Array.from(base58Alphabet).map((c, i) => [c, BigInt(i)]));

export function isSolanaAddress(value) {
  if (typeof value !== 'string' || !addressPattern.test(value)) return false;
  let number = 0n;
  for (const character of value) {
    const digit = base58Index.get(character);
    if (digit === undefined) return false;
    number = number * 58n + digit;
  }
  let bytes = 0;
  for (; number > 0n; number >>= 8n) bytes++;
  let leadingZeroBytes = 0;
  for (const char of value) { if (char === '1') leadingZeroBytes++; else break; }
  return bytes + leadingZeroBytes === 32;
}

// Return validated DECIMAL-compatible strings to avoid floating-point loss in DB.
export function asDecimal(value) {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(str)) return null;
  const numeric = Number(str);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return str;
}

function asCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function parseDate(value) {
  if (!value || typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function tokenFromRef(ref, includedById) {
  const relationId = ref?.data?.id;
  if (typeof relationId !== 'string') return { address: null, symbol: null };
  const linked = includedById.get(relationId)?.attributes || {};
  const address = linked.address || (relationId.startsWith('solana_') ? relationId.slice(7) : null);
  return {
    address: isSolanaAddress(address) ? address : null,
    symbol: typeof linked.symbol === 'string' ? linked.symbol.slice(0, 80) : null
  };
}

export function venueFamily(dexId) {
  const normalized = (dexId || '').toLowerCase();
  if (normalized.includes('pump')) return normalized.includes('swap') ? 'pumpswap' : 'pumpfun';
  if (normalized.includes('raydium')) return 'raydium';
  if (normalized.includes('meteora')) return 'meteora';
  if (normalized.includes('orca')) return 'orca';
  return 'other';
}

export function normalizeGeckoResponse(payload) {
  if (!payload || !Array.isArray(payload.data)) throw new Error('Invalid GeckoTerminal response: data must be an array');
  const includedById = new Map((Array.isArray(payload.included) ? payload.included : [])
    .filter(x => typeof x?.id === 'string').map(x => [x.id, x]));
  const normalized = [];
  const malformed = [];
  for (const item of payload.data) {
    const a = item?.attributes;
    const address = a?.address;
    if (!isSolanaAddress(address)) {
      malformed.push({ id: item?.id ?? null, reason: 'missing_or_invalid_address' });
      continue;
    }
    const dexId = item?.relationships?.dex?.data?.id || null;
    const base = tokenFromRef(item?.relationships?.base_token, includedById);
    const quote = tokenFromRef(item?.relationships?.quote_token, includedById);
    normalized.push({
      address,
      sourcePoolId: item?.id || null,
      dexId,
      family: venueFamily(dexId),
      name: typeof a.name === 'string' ? a.name.slice(0, 255) : null,
      baseMint: base.address,
      quoteMint: quote.address,
      baseSymbol: base.symbol,
      quoteSymbol: quote.symbol,
      createdAt: parseDate(a.pool_created_at),
      priceUsd: asDecimal(a.base_token_price_usd),
      liquidityUsd: asDecimal(a.reserve_in_usd),
      volumeH24Usd: asDecimal(a.volume_usd?.h24),
      volumeM5Usd: asDecimal(a.volume_usd?.m5),
      buysM5: asCount(a.transactions?.m5?.buys),
      sellsM5: asCount(a.transactions?.m5?.sells),
      sourceData: item
    });
  }
  return { pools: normalized, malformed };
}
