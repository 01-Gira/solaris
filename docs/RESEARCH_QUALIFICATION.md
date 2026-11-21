# SOLARIS research qualification contract

Scope is historical, read-only research for Pump.fun and PumpSwap. The unit of transfer evidence is a transaction signature plus an outer instruction index and CPI ordinal, bound to the executing program and the exact watched pool. Each signature contributes at most once to the sample floor. Other venues and unverified program layouts stay out of the qualified set.

Freeze these gates before collecting or evaluating a holdout. They are minimum design safeguards, not a power calculation or a claim of performance. Set larger sample floors prospectively if the predeclared strategy needs them.

| Gate | Required evidence |
| --- | --- |
| Correctness | Offline, integration and adversarial checks pass. Historical interpretation uses a deployed-program layout valid at that slot, inventory of unsupported versions, and a second, independent parser or adjudication source. |
| Provenance and coverage | Finalized block, slot and signature agree across sources. Exact pool and mint association and creation chronology are independently established. A frozen launch universe includes failed and missing observations, and slot/sequence recovery accounts for all gaps within both study windows. |
| Strict fills | Independently verified, successful instruction-level base and quote debits/credits, account ownership and token program, decimals and fees including transfer fees. Identify economic fee recipients independently of destination indexes. Separate network fee, SOL funding, rent and refunds from swap economics. Reconciliation alone cannot supply a verified fill. |
| Holdout | Freeze strategy, study windows, pool and mint assignment, fees and exclusions before collection. Require at least 30 UTC event days, 20 disjoint pools and 200 distinct strict-fill signatures in each of development and forward holdout, a maximum 20% share from any pool per window, and zero signature, pool, or base-mint overlap. Purge cross-boundary positions and delayed observations. |
| Decision-time inputs | Point-in-time pool state and route quotes with decision timestamps, observed latency, liquidity, price impact and failed-attempt coverage. Current mint state and indexed observations cannot substitute for these inputs. |

SOLARIS currently has no approved ingestion contract for independent fill adjudications or predeclared holdout manifests. The audit reports zero **established** verified fills and zero eligible holdout records until such evidence exists. An unknown denominator remains unknown. The qualification report does not authorize economics or enable trading.

## Audit result, November 21, 2026

**BLOCKED_EXTERNAL_EVIDENCE.** The final replay used one PostgreSQL 16 repeatable-read, read-only snapshot at **13:35:24 WIB**. S3 recorded `BLOCKED_DATA`. The report counts zero independently verified fills and zero eligible holdout records. Economics and live trading are disabled.

| Cohort | Event rows | Unique signatures | Unique watched pools | UTC block days | Largest pool share |
| --- | ---: | ---: | ---: | ---: | ---: |
| Recorded event rows | 30,612 | 30,580 | — | — | — |
| All hydrated rows examined | 18,389 | 18,357 | 138 | 4 | 30.70% |
| Stored V2 single-candidate subset | 1,429 | 1,429 | 55 | 4 | 17.21% |
| Received more than 30 days after block time | 29 | 29 | 1 | 2 | 100% |
| New reconciliation with local provenance | 5 | 5 | 1 | 1 | 100% |
| Strict fills / independent holdout | 0 | 0 | 0 | 0 | — |

- **Coverage.** Replayed 100% of available hydrated rows. 12,223 of 30,612 event rows (39.93%) were pending and unattempted. The oldest was about 130 minutes old. In the final five minutes, 297 rows were hydrated and 153 arrived. There were 204 bounded or seeded recovery runs, zero recovery errors and zero resolved events without a payload. These scans leave finalized slot and source continuity unverified. At the initial runtime inspection, the database and recorder were healthy, the stream was connected in external hydration mode with three active pools, and the detached worker was running. No service was restarted.
- **Concentration and duplicates.** The largest three watched pools account for 45.94% of hydrated rows. Thirty-two signatures were each associated with two watched pools (64 rows). Block times partition into 26 rows on August 25, 2024, 3 on August 26, 2024, 1,570 on November 20, 2026, and 16,790 on November 21, 2026. The recent cohort supplies two UTC days. The replay uses event ID order and preserves pool and signature denominators. The existing V2 runner had classified 9,259 hydrated rows at snapshot time.
- **Timestamp and failure evidence.** V2.13 found one historical watched pool, one comparable provider snapshot and a provider creation day of November 21, 2026. All 29 August 2024 rows remain quarantined. Twenty-three have explicit on-chain errors and six are successful RPC transactions with unusable historical account layouts. Across the full replay, 6,344 rows had explicit on-chain errors, 12,045 had JSONB null indicating success, and zero had SQL NULL or an error mismatch with the saved RPC payload. The classified V2 subset included 1,108 errors with PumpSwap `Custom:6040` backed by its failing-program log and outer instruction. These failures describe submission outcomes.
- **Attribution and structural exclusions.** The V2.14 rerun accounted for all 1,429 stored single candidates: 1,267 Pump.fun rows outside that PumpSwap audit, 124 PumpSwap structural matches, 31 watched-pool mismatches, six unusable historical layouts and one unparsed transfer. Legacy V2.15 found three transaction-wide arithmetic matches within the 124 and 121 incomplete cases. The new replay excluded 5,711 Meteora rows and 139 rows from other unsupported venues, including any unrelated Pump instructions in those transactions.
- **Amount evidence.** The new replay observed 1,892 candidate instructions with both scoped transfer quantities and supported recipient routing. It found 919 rows with at least one lifecycle operation for a tracked role, 508 with token transfers outside the candidate scope and four with multiple recognized trade instructions. Five Pump.fun rows passed both scoped amount and whole-transaction diagnostics with no local timestamp conflict. Every one came from the same watched pool and UTC day. For PumpSwap, 79 non-WSOL and 48 WSOL candidate instructions had unidentified or ambiguous recipient routing. The global token checks marked 3,182 Pump.fun and 146 PumpSwap rows as missing Token-2022 net-credit evidence. Across both venues, 3,587 candidate-bearing rows recorded network fee metadata.

| Gate | Result | Evidence |
| --- | --- | --- |
| Local correctness and safety | PASS | Baseline V2.14 had 257 passing tests. Updated main with V2.15 had 265. All 283 final tests passed, including adversarial cases and the isolated PostgreSQL 16 integration test. Syntax checks pass. Stored V2 and S3 economics guard violations were zero. S4 preflight confirmed ChatGPT login and the required CLI flags with zero model calls. |
| Saved-data replay | PASS | All 18,389 hydrated rows were read from one consistent snapshot. Only aggregate results left the process. |
| Independent chain chronology and layout | BLOCKED | The 2024 conflict, historical layouts, slot continuity and current-versus-historical deployment need an independent finalized source and version evidence. |
| Source completeness | BLOCKED | 12,223 pending rows, bounded recovery and no independent source denominator or frozen launch universe. |
| Strict fills | BLOCKED | Zero independently verified. Native curve sell payouts, historical recipient authorization, and implicit Token-2022 fees remain unresolved in the saved data. |
| Independent holdout | BLOCKED | Zero eligible records, no predeclared manifest, two recent UTC event days and one pool in the locally reconciled set. |
| Decision-time inputs | BLOCKED | No verified decision-time quote, route state, failure/latency and liquidity evidence meeting the contract. |

A separate read-only S3 coverage probe at 13:39 WIB evaluated the 50 newest pools. Zero passed the existing gate. Every pool had too few snapshots, insufficient observed span and insufficient price variation. The recorder health endpoint passed. The polling window contained 375 successful and two partial runs over less than 24 hours of operation. The 25 stored S2 assessments and one completed S4.2 task all had economics authorization disabled.

## What the code can establish

The new auditor matches known discriminators to the correct program, checks exact watched-pool identity, verifies unique message account indexes and checks CPI parentage. It uses unsigned integer base units and compares decimals, mint, token-account owner and token program. Token-2022 checked-with-fee supports exact gross debit and credited units. Plain Token-2022 transfers can withhold an epoch-dependent fee. Rows with unknown fee treatment stay blocked. Untracked token movements remain visible in the transaction-wide replay. ATA initialization and closure require ordered evidence. The fresh ATA funding branch can establish the exact WSOL reserve. Preexisting or prefunded accounts without reserve evidence stay unresolved. The fee payer, network fee, System transfers and lamport effects of WSOL transfers and closure are modeled separately from a candidate's token amounts.

Current confirmed layouts include Pump.fun legacy, v2 and v3 and PumpSwap legacy and v2. Unsupported layouts, multi-hop instructions without an independently scoped child trade, and historical layouts that cannot be mapped stay excluded. The Pump.fun self-CPI `TradeEvent` gives a program-reported consistency check. The program can directly debit lamports from its bonding curve on sells. Recorded balances and that event cannot independently establish the instruction's native payout, rent, or the economic splits. Fixed recipient roles come from the official layouts. Unknown remaining recipients stay unassigned, and fixed roles alone do not establish authorization at a historical slot. The reports through V2.15 remain useful for reproducibility of earlier structural diagnostics.

Primary sources checked include the official [Pump.fun IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json) (blob `bb79d04e5a4ef8b286d67511757c23a15672ef51`), [PumpSwap IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json) (blob `d907b16a91f035aeb3c3182bfa0972a91bf23a86`), [retained fee rules](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/SWEEP_FEES.md), [Solana RPC transaction fields](https://solana.com/docs/rpc/json-structures), [Token-2022 transfer fees](https://solana.com/docs/tokens/extensions/transfer-fees), [WSOL synchronization](https://solana.com/docs/tokens/basics/sync-native), [ATA rent funding implementation](https://github.com/solana-program/associated-token-account/blob/main/program/src/tools/account.rs), and [Anchor self-CPI encoding](https://github.com/otter-sec/anchor/blob/master/lang/attribute/event/src/lib.rs).

## Reproduce the audit

```sh
npm test
npm run check
npm run s4:doctor

# Use the running database and the existing decode image's dependencies.
# The source mount is read-only and --no-deps leaves running services alone.
mkdir -p .solaris
docker-compose -f compose.yaml -f compose.s1b1.yaml run --rm --no-deps -T \
  -v "$PWD/src:/app/src:ro" decode node src/s1b1/qualification-report.js \
  > .solaris/research-qualification-2026-11-21.json
```

For the local PostgreSQL integration check, start an empty, disposable PostgreSQL 16 fixture on localhost. Set `SOLARIS_FIXTURE_DATABASE_URL` to its `/solaris_fixture` database and run `node --test test/qualification-report.test.js`. CI starts its own fixture. Never point the integration test at the collector database. To rerun against a larger live record set, use the emitted snapshot timestamp and watermark when comparing reports. `SOLARIS_QUALIFICATION_LIMIT` can lower the replay bound. A truncated replay explicitly blocks its coverage gate.

## Minimum evidence to unblock

1. Let the existing detached worker drain its queue. Re-run the report and compare pending, missing and unavailable counts. Keep the existing shared RPC pacer. More hydration may improve internal coverage, but it cannot prove chain continuity or produce an independent holdout.
2. Freeze the research strategy, target venues, launch universe, development and forward windows, group assignments and exclusions. Record the finalized slot ranges. In an isolated fixture database or private append-only evidence store, replay public finalized block and program history from an independent archival source with bounded requests. Store missing and failed queries as gaps. Include raw transaction bytes, complete inner instructions, pre/post token and lamport evidence, program deployment/version linkage and point-in-time mint extensions. Reconcile finalized slot/block identity, candidate ordinal, pool, mint, and creation instruction before adjudicating. Retain unresolved historical rows in the original dataset.
3. Have an independent reviewer approve the fill evidence contract and adjudicate exact instruction debit/credit, economic recipient, native transfers and Token-2022 fees. Preserve raw evidence privately, then publish only counts and the adjudication manifest summary. The 30-day, 20-pool and 200-signature minimum applies separately to the two non-overlapping windows, with a maximum 20% share per pool. Require point-in-time route quotes and forward observations of latency and unsuccessful attempts. Begin economic research only when all gates pass.
