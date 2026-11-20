import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { decodeObservedTransaction, DECODER_VERSION } from './decoder.js';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error('DATABASE_URL missing');
const client = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 10000 });
const limit = Number(process.env.S1B1_MAX_EVENTS || 1000);
if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('S1B1_MAX_EVENTS must be 1..100000');
const summary = { total: 0, byStatus: {}, decoderVersion: DECODER_VERSION };
try {
  await client.connect();
  await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  // Keyset-like ordered batches; only previously undecoded hydrated events are selected.
  while (summary.total < limit) {
    const { rows } = await client.query(`
      SELECT e.pool_address,e.signature,t.payload
      FROM onchain_pool_events e
      JOIN onchain_transactions t ON t.signature=e.signature
      LEFT JOIN onchain_trade_decodes d ON d.pool_address=e.pool_address AND d.signature=e.signature
      WHERE d.signature IS NULL
      ORDER BY e.id
      LIMIT $1`, [Math.min(limit - summary.total, 100)]);
    if (!rows.length) break;
    for (const row of rows) {
      let decoded;
      try { decoded = decodeObservedTransaction(row.pool_address, row.signature, row.payload); }
      catch (error) { decoded = { poolAddress: row.pool_address,signature:row.signature,
        decoderVersion: DECODER_VERSION,status:'unknown',reason:'internal_decoder_error',
        evidence:{errorCode:error?.name||'unknown'} }; }
      await client.query(`INSERT INTO onchain_trade_decodes
        (pool_address,signature,decoder_version,status,reason,dex,instruction_name,program_id,
         side,wallet,base_mint,quote_mint,base_amount_raw,quote_amount_raw,price_quote_per_base,price_sol,evidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
        ON CONFLICT(pool_address,signature) DO NOTHING`,
        [row.pool_address,row.signature,decoded.decoderVersion,decoded.status,decoded.reason||null,
         decoded.dex||null,decoded.instructionName||null,decoded.programId||null,decoded.side||null,
         decoded.wallet||null,decoded.baseMint||null,decoded.quoteMint||null,decoded.baseAmountRaw||null,
         decoded.quoteAmountRaw||null,decoded.priceQuotePerBase||null,decoded.priceSol||null,
         JSON.stringify(decoded.evidence||{})]);
      summary.total++;
      summary.byStatus[decoded.status] = (summary.byStatus[decoded.status]||0)+1;
    }
  }
  console.log(JSON.stringify({kind:'s1b1_decode_complete',...summary}));
} catch (error) {
  console.error(JSON.stringify({kind:'s1b1_decode_failed',name:error?.name,message:error?.message}));
  process.exitCode=1;
} finally {
  await client.end().catch(()=>{});
}
