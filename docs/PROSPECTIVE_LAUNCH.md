# Prospective launch qualification

The existing [forward evidence workflow](FORWARD_RESEARCH.md) still accepts fixed-universe manifests. For newly launched pools, freeze a manifest with `universe.mode` set to `prospective-launch-v1`. Its development and forward windows contain only `from` and `until`. Future pool addresses and base mints do not appear in the manifest.

## Preregistered selection

The prospective `universe` has exactly these fields:

| Field | Required choice |
| --- | --- |
| `mode`, `algorithm` | `prospective-launch-v1`, `first-eligible-creation-v1` |
| `venues` | A nonempty subset of `pumpfun` and `pumpswap` |
| `quoteMints` | A nonempty list of allowed quote mint addresses. For native SOL, use the same WSOL unit identifier the forward contract uses. |
| `excludedBaseMints` | A frozen list of base mint exclusions, or `[]` |
| `maxDiscoveryDelayMs` | From 1 second to 15 minutes after the finalized creation block time |
| `maxAdmissionDelayMs` | At least the discovery bound and at most 60 minutes after the creation block time. Admission also must precede the window end. |
| `issuers` | `{ "discovery": "DISCOVERY_ID", "enrollment": "ENROLLMENT_ID" }` from the approved policy |

Pin the existing `strategy`, `selection`, `feeModel`, and `exclusions` artifacts and the numeric `maxQuoteAgeMs`, `maxObservedLatencyMs` and `horizonMs`. Choose the two nonoverlapping UTC windows and clock-seal the manifest before the first opens. The operator must preregister scope and decision rules in the artifacts and may not revise the frozen study after observing results.

The rule uses successful in-scope creation instructions, the frozen quote allowlist, and the frozen base mint exclusions. It orders eligible creations by finalized slot, then the transaction's position in the signed block roster, then outer and inner instruction indexes. It reserves the first eligible pool and base mint across both windows, including launches whose observations fail or never arrive. A later pool for the same base mint cannot replace it. Common quote mints may appear in both windows. Failed creation instructions and launches excluded by the frozen asset rules do not consume a reservation. No prices, liquidity, trading activity, later returns, or survival enter this selection. The rule covers pool launches in the declared venues and windows. It does not claim the first use of a mint in all Solana history. [Solana finalized block fields](https://solana.com/docs/rpc/http/getblock), [inner instruction coordinates](https://solana.com/docs/rpc/json-structures#inner-instructions).

## Additional evidence

The existing `block`, `segment`, `pool`, `census`, `quote`, `decision`, `fill`, and `timestamp` formats remain in use. Prospective admission additionally requires clock receipts for the archive segment commitments, the chosen finalized block receipts, and the independent `pool` proof. Keep all subject digests and artifacts in the private store. Clock receipts must attest when the authority actually observed the signed envelope. A claimed earlier `observedAt` field by itself cannot establish an earlier seal.

| Record | Body and verification |
| --- | --- |
| `launch_scan` from `census` | `{plan,window,segment,scannedAt,evidenceDigest,launches}`. Exclusive to prospective mode. Two separately operated census organizations must scan the same agreed archive segment and certify a complete inventory for the window. Neither can also perform another study role. Archive segment commitments and both inventory envelopes need independent clock receipts. Array order has no effect on consensus. Provide empty scans for segments with no launches, including observation and exit segments. |
| Launch inventory row | A `created` or `failed` row carries `status`, `slot`, `blockhash`, `signature`, `outerIndex`, `innerIndex`, `venue`, `address`, `baseMint`, and `quoteMint`. The receipt status and supported creation instruction must agree. A `missing` or `unavailable` row carries `status` and `slot`. Include failed attempts, missing evidence, and known unresolved slots. Independently witnessed creates omitted from both scans block qualification. The archive and census operators must review completeness for launches that were never captured locally. |
| `discovery` from the pinned discovery issuer | `{plan,launch,status,observedAt,evidenceDigest}`. `launch` is the canonical SHA-256 of the exact inventory row. Use `observed`, `failed`, or `unavailable`. Both the observation and the independent clock receipt must fit the discovery bound. The first independently sealed observation governs; a tied and conflicting entry is ambiguous. No timely observation produces the stable `missing_timely_discovery` rejection. |
| `launch_outcome` from the pinned enrollment issuer | `{plan,window,segment,scan,launch,result,reason,discovery,archiveReceipts,poolProof}`. Use the exact body produced by `launch-ledger`. The expected outcome binds the two agreed inventories and, for admission, the discovery, two separately clocked archive receipt envelopes, and the independently verified pool proof. Every outcome must be signed and clock-sealed. Rejections and missing observations are recorded alongside admissions. An unsigned draft or late admission does not enroll a pool. |
| Prospective `decision` | In addition to the existing fields, include `admission` with the exact signed `launch_outcome` envelope digest. The quote's request **and source** times must be at or after the admission seal, and the existing quote and decision seals must predate the trade. Decisions on unadmitted pools or missing from the independent attempt census block completeness. |

Use short archive segments during a launch window so finalized receipts, both scans, and admission can be sealed before the frozen deadline. Each window requires an uninterrupted launch scan path with an anchor before the start, an end boundary, and the same certified segments used by the attempt census. A forward admission requires the sealed development launch prefix, including its reservations, and a shared finalized chain. Archive evidence that becomes available after a deadline can explain a gap. It cannot make that pool eligible after the fact. Preserve original records and keep a checkpoint at each milestone. Do not remove records to make a gate pass.

## Operator checklist

1. **Independent archives.** Approve two operators with separate custody and upstream provenance. Request finalized block rosters, full selected creation receipts, merkle segment proofs, and historical program and pool state. Check that each can sign the normalized envelopes and obtain independent clock receipts as they arrive. Use bounded read-only capture or offline exports. The collector's existing RPC configuration does not establish independence.
2. **Signing authorities.** Prepare a private policy with the existing chain, history, execution, market, strategy, timestamp, and census roles. Register two dedicated census organizations and the separately operated discovery and enrollment issuers. Keep the clock organization separate from all study roles. Verify the approved IDLs, issuer public keys, organizations and resulting digest with `research:forward -- policy POLICY`. Never import private keys.
3. **Clock and quote capture.** Exercise the independent clock on an archive segment, paired receipts, a history proof, launch scan, discovery and outcome. Check that seals arrive within the intended cutoffs. Verify quote source time, receipt time, quote seal and decision seal with a test observation. Strategy decisions must reference the admission digest. Retain failed or unavailable observations rather than dropping them.
4. **First freeze.** Prepare the policy and artifacts, then freeze prospective windows containing just UTC `from` and `until`. Enter the algorithm, allowed venues and quote mints, exclusions, maximum delays, and issuer IDs. Sign the manifest digest with the independent clock before development starts. Fix the decision-time and holding-period rules before collecting any outcome. Record the initial checkpoint and verify the manifest has no future pool or base mint list.
5. **Initial mainnet smoke test.** Verify no-cost access before invoking the optional bounded read-only `capture`. Use independently approved mainnet exports if available. After the frozen window opens, check a small segment containing a newly created pool, including both receipts, both scans, signed discovery and the independent pool proof. Export `launch-ledger` before the deadline, sign and clock the matching outcome, and import it. Check that the report lists one admission only after these records and refuses a rejection or an expired draft. Then capture a quote and a research-only decision commitment. Do not submit any blockchain transaction. If sources or authorities are missing, record the blocker and skip the network smoke test.
6. **Forward monitoring.** Run `report` or bounded `watch` on the pinned study. Track missing scan quorums, omitted witnessed launches, `byEvidenceGap`, pending or missing outcome seals, conflicting outcomes, quote/decision gaps and independent strict fills. Review gaps with the evidence issuers. Checkpoint the store at the development and holdout closes for reproducible replay. Require at least 30 UTC event days, 20 disjoint pools and 200 strict-fill signatures per window, at most 20% concentration in one pool, and no shared pool, base mint, signature or decision. Leave S3's economics and trade controls untouched.

```sh
npm run --silent research:forward -- freeze STORE POLICY PLAN
npm run --silent research:forward -- import STORE POLICY SIGNED_BUNDLE
npm run --silent research:forward -- launch-ledger STORE POLICY MANIFEST_SHA /private/unsigned-outcomes.json
npm run --silent research:forward -- report STORE POLICY MANIFEST_SHA
npm run --silent research:forward -- watch STORE POLICY MANIFEST_SHA 60 10
```

`launch-ledger` requires a clock-sealed prospective manifest. It writes a private file once. Its `bodies` array contains unsigned outcomes for the enrollment authority to verify and sign. The signer must sign the exact body using the standard envelope. An existing output file cannot be overwritten. For retrospective audit, the optional final `AS_OF_UTC` argument bases the preview on exactly that instant. It does not backdate a clock receipt.
