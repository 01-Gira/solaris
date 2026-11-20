// SOLARIS S1b.1 / v0.3.0: fail-closed identification of Pump.fun and PumpSwap swaps.
// Discriminators/account layout sourced from pump-fun/pump-public-docs IDLs.
// Only confirmed SPL quote-token deltas qualify for an execution price.
export const PUMP_FUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_SWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const WSOL = 'So11111111111111111111111111111111111111112';
export const DECODER_VERSION = 's1b1-0.3.0';

const SCHEMAS = {
  [PUMP_FUN]: {
    family: 'pumpfun',
    // account index: global0 fee1 mint2 bonding_curve3 user_token4? actual associated_user=5, user=6
    // buy / sell / buy_exact_sol_in: index 5 is associated_user, 6 is signer user.
    buy: { disc: [102,6,61,18,1,218,235,234], side: 'BUY', pool: 3, wallet: 6, base: 2, baseTokenAccount: 5 },
    sell: { disc: [51,230,133,164,1,127,131,173], side: 'SELL', pool: 3, wallet: 6, base: 2, baseTokenAccount: 5 },
    buy_exact_sol_in: { disc: [56,252,116,8,158,223,205,95], side: 'BUY', pool: 3, wallet: 6, base: 2, baseTokenAccount: 5 },
    buy_v2: { disc: [184,23,238,97,103,197,211,61], unsupported: true },
    sell_v2: { disc: [93,246,130,60,231,233,64,178], unsupported: true }
  },
  [PUMP_SWAP]: {
    family: 'pumpswap',
    buy: { disc: [102,6,61,18,1,218,235,234], side: 'BUY', pool: 0, wallet: 1, base: 3, quote: 4, baseTokenAccount: 5, quoteTokenAccount: 6 },
    buy_exact_quote_in: { disc: [198,46,21,82,180,217,232,112], side: 'BUY', pool: 0, wallet: 1, base: 3, quote: 4, baseTokenAccount: 5, quoteTokenAccount: 6 },
    sell: { disc: [51,230,133,164,1,127,131,173], side: 'SELL', pool: 0, wallet: 1, base: 3, quote: 4, baseTokenAccount: 5, quoteTokenAccount: 6 }
  }
};

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function decodeBase58(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.length) return null;
  let n = 0n;
  for (const c of value) {
    const digit = alphabet.indexOf(c);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  let zeroes = 0;
  while (value[zeroes] === '1') zeroes++;
  return Buffer.from([...Array(zeroes).fill(0), ...bytes]);
}

function instructions(tx) {
  const result = [];
  for (const [outerIndex, ix] of (tx.transaction?.message?.instructions || []).entries()) {
    result.push({ ix, outerIndex, inner: false });
  }
  for (const group of tx.meta?.innerInstructions || []) {
    for (const ix of group.instructions || []) result.push({ ix, outerIndex: group.index, inner: true });
  }
  return result;
}

function recognize(item) {
  const ix = item.ix;
  if (!ix || !SCHEMAS[ix.programId]) return null;
  const bytes = decodeBase58(ix.data);
  if (!bytes || bytes.length < 8) return { ...item, family: SCHEMAS[ix.programId].family, unsupported: true, instruction: 'unparsed' };
  const schema = SCHEMAS[ix.programId];
  const variant = Object.entries(schema).find(([k, def]) => k !== 'family' && Buffer.from(def.disc).equals(bytes.subarray(0, 8)));
  if (!variant) return { ...item, family: schema.family, unsupported: true, instruction: 'unknown' };
  return { ...item, family: schema.family, instruction: variant[0], ...variant[1] };
}

function accountKeys(tx) { return (tx.transaction?.message?.accountKeys || []).map(x => typeof x === 'string' ? { pubkey: x, signer: false } : x); }
function tokenDelta(tx, accountIndex, mint, wallet) {
  const pre = (tx.meta?.preTokenBalances || []).filter(x => x.accountIndex === accountIndex);
  const post = (tx.meta?.postTokenBalances || []).filter(x => x.accountIndex === accountIndex);
  if (pre.length > 1 || post.length > 1 || (!pre.length && !post.length)) return null;
  const p = pre[0], q = post[0];
  if ((p && (p.mint !== mint || (p.owner && p.owner !== wallet))) ||
      (q && (q.mint !== mint || (q.owner && q.owner !== wallet)))) return null;
  const decimals = p?.uiTokenAmount?.decimals ?? q?.uiTokenAmount?.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 ||
      (p && q && p.uiTokenAmount?.decimals !== q.uiTokenAmount?.decimals)) return null;
  const amountPattern = /^\d+$/;
  const a = p?.uiTokenAmount?.amount ?? '0';
  const b = q?.uiTokenAmount?.amount ?? '0';
  if (!amountPattern.test(a) || !amountPattern.test(b) || !(p?.owner === wallet || q?.owner === wallet)) return null;
  return { raw: (BigInt(b) - BigInt(a)), decimals };
}

// Fixed point division, no JS floating point and no scientific notation.
export function ratioToDecimal(quoteRaw, quoteDecimals, baseRaw, baseDecimals, precision = 18) {
  if (baseRaw <= 0n || quoteRaw <= 0n) return null;
  const numerator = quoteRaw * 10n ** BigInt(baseDecimals + precision);
  const denominator = baseRaw * 10n ** BigInt(quoteDecimals);
  const result = numerator / denominator;
  if (result === 0n) return null; // Never report a real price as zero due to precision.
  const digits = result.toString().padStart(precision + 1, '0');
  return (digits.slice(0, -precision) + '.' + digits.slice(-precision)).replace(/\.?0+$/, '') || '0';
}

export function decodeObservedTransaction(poolAddress, signature, tx) {
  const base = { poolAddress, signature, decoderVersion: DECODER_VERSION, status: 'unknown', reason: null,
    dex: null, instructionName: null, programId: null, side: null, wallet: null,
    baseMint: null, quoteMint: null, baseAmountRaw: null, quoteAmountRaw: null,
    priceQuotePerBase: null, priceSol: null, evidence: {} };
  const reject = (status, reason, detail = {}) => ({ ...base, status, reason, ...detail });
  if (!tx?.meta || !tx?.transaction?.message) return reject('unknown', 'missing_transaction_metadata');
  if (Array.isArray(tx.transaction.signatures) && !tx.transaction.signatures.includes(signature)) return reject('unknown','signature_mismatch');
  if (tx.meta.err !== null && tx.meta.err !== undefined) return reject('failed_onchain', 'meta_err_present');
  const matches = instructions(tx).map(recognize).filter(Boolean);
  if (!matches.length) return reject('unsupported_dex', 'no_supported_dex_instruction');
  if (matches.length !== 1) return reject('ambiguous', 'multiple_dex_instructions', { evidence: { count: matches.length } });
  const match = matches[0];
  const identified = { dex: match.family, instructionName: match.instruction, programId: match.ix.programId,
    evidence: { instructionIndex: match.outerIndex, inner: match.inner, version: tx.version ?? 'legacy' } };
  if (match.unsupported) return reject('unsupported_variant', 'unknown_or_unsupported_instruction_layout', identified);
  const accounts = match.ix.accounts;
  const keys = accountKeys(tx);
  if (!Array.isArray(accounts) || accounts.length <= Math.max(match.pool,match.wallet,match.base,match.baseTokenAccount, match.quoteTokenAccount ?? 0))
    return reject('ambiguous', 'incomplete_instruction_accounts', identified);
  if (accounts[match.pool] !== poolAddress) return reject('unrelated_pool', 'different_pool', identified);
  const wallet = accounts[match.wallet], mint = accounts[match.base];
  if (!keys.some(k => k.pubkey === wallet && k.signer === true)) return reject('ambiguous', 'wallet_not_proven_signer', identified);
  const baseAccountIndex = keys.findIndex(k => k.pubkey === accounts[match.baseTokenAccount]);
  if (baseAccountIndex < 0) return reject('ambiguous', 'base_token_account_missing', identified);
  const baseDelta = tokenDelta(tx, baseAccountIndex, mint, wallet);
  if (!baseDelta || baseDelta.raw === 0n || (match.side === 'BUY' && baseDelta.raw < 0n) || (match.side === 'SELL' && baseDelta.raw > 0n))
    return reject('ambiguous', 'base_balance_delta_unverified', identified);
  const quantity = (baseDelta.raw < 0n ? -baseDelta.raw : baseDelta.raw).toString();
  const trade = { ...identified, status: 'direction_only', reason: 'quote_amount_unverified', side: match.side,
    wallet, baseMint: mint, baseAmountRaw: quantity,
    evidence: { ...identified.evidence, baseDecimals: baseDelta.decimals, amountSource: 'transaction_token_account_balance_delta' } };
  if (match.family === 'pumpfun') return { ...base, ...trade };
  const quoteMint = accounts[match.quote];
  const quoteIndex = keys.findIndex(k => k.pubkey === accounts[match.quoteTokenAccount]);
  if (quoteIndex < 0 || quoteMint === mint) return { ...base, ...trade, reason: 'quote_token_account_missing_or_same_mint', quoteMint };
  const quoteDelta = tokenDelta(tx, quoteIndex, quoteMint, wallet);
  if (!quoteDelta || quoteDelta.raw === 0n ||
      (match.side === 'BUY' && quoteDelta.raw >= 0n) || (match.side === 'SELL' && quoteDelta.raw <= 0n))
    return { ...base, ...trade, quoteMint, reason: 'quote_balance_delta_unverified' };
  const quoteQuantity = quoteDelta.raw < 0n ? -quoteDelta.raw : quoteDelta.raw;
  const price = ratioToDecimal(quoteQuantity, quoteDelta.decimals, BigInt(quantity), baseDelta.decimals);
  return { ...base, ...trade, quoteMint, quoteAmountRaw: quoteQuantity.toString(), priceQuotePerBase: price,
    priceSol: quoteMint === WSOL ? price : null,
    status: 'matched_quote_delta', reason: price === null ? 'price_below_18_decimal_precision' : null,
    evidence: { ...trade.evidence, quoteDecimals: quoteDelta.decimals,
      quoteSource: 'transaction_token_account_balance_delta', priceSemantics: 'transaction_net_account_ratio_not_instruction_fill_price',
      exactPerInstruction: 'single_dex_instruction_in_transaction' } };
}
