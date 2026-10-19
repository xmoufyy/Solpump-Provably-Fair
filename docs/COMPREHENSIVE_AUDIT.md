# Solpump Fairness Lab — comprehensive audit (v1.0.0 → v2.0.0)

**Audited baseline:** commit `13699a2` · **Result:** v2.0.0 on `main` · **Date:** 2026-10-19

Companion documents:

* [`AUDIT_BASELINE.md`](AUDIT_BASELINE.md)
* [`CRYPTOGRAPHIC_PARITY_REPORT.md`](CRYPTOGRAPHIC_PARITY_REPORT.md)
* [`PERFORMANCE_REPORT.md`](PERFORMANCE_REPORT.md)
* [`CHANGELOG_V2.md`](CHANGELOG_V2.md)
* [`AUDIT_RESULTS.txt`](AUDIT_RESULTS.txt) (last `npm run audit:all` output)

## Executive summary

* **Cryptography — no defects found.** The four game algorithms, in both current and legacy versions, are correct with respect to the reference code supplied with the project. That is now shown three ways:
  * agreement between three implementations (production TypeScript, the unchanged JS reference, and an independent Python implementation with its own seedrandom port) on 2,055 deterministic edge-heavy cases;
  * 11 mutation tests proving the suite detects plausible bugs;
  * crafted tests for the rare rejection-sampling path.
* **External confirmation is still missing.** Solpump's live documentation could not be retrieved (bot-verification page, not bypassed), and no genuine historical round was available.
* **Verification logic around the algorithms — real defects found.** Two produced **false "Match" verdicts**:
  * Crash multipliers were compared after rounding (F-01);
  * duplicate Mines positions passed a set comparison (F-02).

  Others silently altered evidence (F-05: JSON nonces beyond 2^53) or hid it in the UI (F-09, F-10). All are fixed, each with a regression test that **fails on v1 and passes on v2**.
* **Security.** The local API could be reached by any web page through DNS rebinding, and by any other `localhost` origin through permissive CORS. Exports were open to CSV formula injection. Inputs and untrusted RPC responses were unbounded. Nine findings were fixed; 13 security tests fail on v1 and pass on v2.
* **Reliability and performance.**
  * A 100k-row import froze the whole app for **19 s**; now the longest stall is **0.24 s**.
  * The database was **2.4× smaller** for the same data.
  * Analytics went from full JSON scans to SQL aggregation with caching.
  * Versioned, backed-up, reversible migrations and idempotent imports were added.
* **Test totals:** 70 tests before the audit (62 Vitest + 8 Playwright), **158** after: 92 unit + parity, 48 integration, 18 browser. Plus a three-way parity run of 2,055 cases. All pass; see "Testing results".

**Verdict:** v2 is reliable for **reconstructing** historical Solpump rounds from revealed seeds and **comparing** them with recorded outcomes, *under the assumption that the supplied reference algorithms are Solpump's*.

It cannot, and does not claim to, establish:

* that Solpump's live algorithms equal those references;
* that seeds were committed before play (the commitment scheme is unconfirmed and no timing evidence is linked);
* correct payouts.

## Severity-ranked findings

Legend:

* **Status:** ✅ fixed · ⚠️ mitigated or documented · ℹ️ not a defect.
* **Test:** the regression test that fails on v1 and passes on v2, where practical.

### CRITICAL

None. No defect was found in the HMAC, transcript, generator or game algorithms (see the parity report).

### HIGH

| ID | Finding | Files | Reproduction (v1) | Root cause | Fix | Test |
|---|---|---|---|---|---|---|
| F-01 ✅ | **Crash false match:** reported 1.254x (or 1.249x) verified as a *match* for a 1.25x round | `verification/engine.ts` | Verify Crash with the synthetic seeds and reported 1.254 → "Match" | Both sides compared with `toFixed(2)`, which rounds | Exact comparison. The algorithm only yields k/100 and the parsed decimal is the same double, so `===` is exact. A note explains values with more than 2 decimals | `unit/regressions.test.ts` F-01; e2e "Crash: 1.254 is a mismatch" |
| F-02 ✅ | **Mines false match:** reported `[0,0,14]` matched actual `[0,14,22]` | `verification/engine.ts` | Mines 5×5/3, reported "0 0 14" → "Match" | `sameSet` checked lengths plus `every(includes)`, so duplicates passed | Multiset comparison, explicit duplicate and count checks, reported in the comparison row | F-02 tests |
| F-05 ✅ | **Evidence silently altered:** a JSON import with `"nonce": 9007199254740993` was verified with nonce …992 | `imports/parse.ts` | JSON import with a numeric nonce above 2^53 | `JSON.parse` loses digits and `String(n)` stored the rounded value | Numeric nonces and round IDs that are not safe integers are rejected with an explanation; string values are preserved exactly | F-05 tests |
| S-01 ✅ | **DNS rebinding:** any website could read every stored seed and round, start imports and delete records | `api/app.ts` | Request with `Host: attacker.example` → 200 | No Host validation on an unauthenticated local API | `onRequest` Host allow-list: localhost, 127.0.0.1, [::1], plus `SFL_ALLOWED_HOSTS` → otherwise 421 | `integration/security.test.ts` S-01 |
| P-02 ✅ | **App froze during imports:** 19.1 s at 100k rows, 2.2 s at 10k | `api/app.ts`, `imports/*` | `bench/bench.ts` stall metric | Whole import verified synchronously in one request | Background jobs with time-sliced transactions, lazy parsing and yields; pause/resume/cancel and progress | `integration/v2.test.ts` "keeps the API responsive"; e2e batch test |

### MEDIUM

| ID | Finding | Files | Root cause | Fix | Test |
|---|---|---|---|---|---|
| S-02 ✅ | Any `http://localhost:*` origin could read and modify data (CORS), and cross-site POSTs were not refused | `api/app.ts` | `@fastify/cors` allowed every localhost origin | CORS removed (the Vite dev proxy makes it unnecessary); state-changing requests must be same-origin (403) | S-02 |
| S-03 ✅ | CSV export formula injection (`=HYPERLINK(...)` in a round ID or source) | `exports/reports.ts` | Cells written verbatim | Cells starting with `= + - @ TAB CR` are prefixed with `'` in CSV only; JSON keeps exact values | S-03 |
| F-03 ✅ | Unbounded work per request: 100k reported cards → 100k HMACs; 1 MB seeds; unbounded lists | `verification/schemas.ts`, `api/app.ts` | No limits in the Zod schemas or tool endpoints | `LIMITS` in `shared/contracts.ts`: seed ≤ 4096 chars, lists ≤ 100, cards ≤ 520, HMAC parts ≤ 32. Over-long input is **rejected, never truncated** | F-03, S-08 |
| F-06 ✅ | A commitment mismatch on a matching outcome was reported as a *result* mismatch | `verification/engine.ts`, migration v1 | One `mismatch` bucket | New final assessment `commitment_mismatch`; stored v1 rows remapped by the migration | F-06; migration test |
| F-09 ✅ | Reported multiplier 1.254 was *displayed* as "1.25x" in history and CSV, next to a "Mismatch" badge | `shared/src/parsing.ts` | `toFixed(2)` on reported values | Reported values shown unrounded | F-09; e2e |
| S-09 ✅ | Untrusted Solana RPC responses read without a size limit; redirects followed | `blockchain/solana.ts` | `res.json()` on an arbitrary endpoint | 8 MB streaming cap, `redirect: "error"`, typed and validated fields, log lines capped | S-09 (local 12 MB server) |
| R-01 ✅ | No schema versioning or migrations, so any change would break existing databases | `database/*` | `CREATE TABLE IF NOT EXISTS` only | `PRAGMA user_version` migrations, automatic `VACUUM INTO` backup before migrating non-empty databases, tested `down` migration, refusal to open newer schemas | `integration/v2.test.ts` migration suite (uses an **authentic v1 database** generated by the v1 code) |
| R-02 ✅ | Re-importing a file duplicated every round | `imports/jobs.ts` | No identity for rounds | SHA-256 fingerprint of identity fields; duplicates skipped by default and counted | idempotency tests (fresh and migrated DBs) |
| P-03 ✅ | Stats and integrity JSON-parsed every row (4.8 s / 5.5 s at 100k); integrity returned 29.6 MB | `auditing/*`, `database/db.ts` | Aggregation in JS over full rows | SQL aggregation, single-scan status checks, bounded output, write-counter cache | stats equivalence test; bench |
| P-04 ✅ | 5.5 KB per stored round (556 MB per 100k) | `database/db.ts` | Inputs and outcomes duplicated inside `result_json`, with the trace and repeated notes | Columns hold the facts; imported rows store a compact result and rebuild notes, comparisons and trace from inputs on view (with a reproduction check) | detail-view regeneration tests |
| U-01 ✅ | Pasting or loading a large file into the import textarea froze the page | `BatchPage.tsx` | Megabytes in a controlled `<textarea>` | Files over 200 KB kept in memory and summarised | e2e 30k-row file upload |
| A-01 ✅ | Duplicated, drifting copies of types, status labels and card parsers in frontend and backend | `frontend/src/services/api.ts`, `backend/*` | No shared module | `shared/src/contracts.ts` and `shared/src/parsing.ts` used by both | typecheck |

### LOW

| ID | Finding | Fix |
|---|---|---|
| S-04 ✅ | `%` and `_` in history search acted as wildcards | `LIKE … ESCAPE '\'` with escaped input (test S-04, e2e) |
| S-05 ✅ | Malformed query parameters returned 500 with internal Zod output | `safeParse` → 400; unexpected errors masked; request bodies (seeds) never logged (test S-05) |
| S-06 ✅ | No security headers | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, CSP for the app, script-free CSP on HTML reports (test S-06) |
| S-07 ✅ | RPC URL accepted `javascript:` and `file:` | http(s) only (test S-07) |
| S-08 ✅ | HMAC inspector accepted unbounded parts and lengths | bounded (test S-08) |
| F-07 ✅ | A pretty-printed single JSON object was parsed as JSONL, so every line was rejected | parse-first format detection (test F-07) |
| F-08 ✅ | Mines field `"mines": [0,14,22]` was read as the mine count | list → reported positions (test F-08) |
| F-10 ✅ | History detail title applied CSS `capitalize` to the **round ID** (`m1` shown as `M1`) | only the game name is capitalised |
| F-11 ✅ | Mines UI converted 1-based reported positions to 0-based **before storing**, so the original numbering was lost | positions and clicked tiles are sent and stored exactly as entered, with their `indexBase` |
| F-12 ✅ | "Reproduced" compared the whole `calculated` JSON blob; any new field (e.g. `indices`) made old records look non-reproducible | comparison on outcome-defining values only (`outcomeKey`); tested on authentic v1 rows |
| R-03 ✅ | History search: a slow response could overwrite a newer one (race) | debounced, `AbortController` |
| R-04 ✅ | Keno pick toggling relied on closure state, so rapid clicks were lost (fixed in v1 by functional updates, now a pure reducer) | `pickReducer` |
| A-02 ✅ | Tests used `randomBytes`, so failures were not reproducible | deterministic SHA-256 counters |
| A-03 ✅ | No linter; `any` used for API payloads | ESLint (typescript-eslint, react-hooks), `no-explicit-any` in app code, `Math.random` banned |
| A-04 ✅ | Unused dependency after hardening (`@fastify/cors`), dead module (`auditing/stats.ts`) | removed |
| U-02 ✅ | Accessibility: no labels or `aria-pressed` on board tiles; radio groups not arrow-key navigable; no visible focus style; no reduced-motion support; no skip link; error text not linked to fields | all added; e2e keyboard test |
| ℹ️ F-04 | Suspected: a UTF-8 BOM would hide the first CSV column | **Not a defect:** `String.prototype.trim` strips U+FEFF. Test kept as a guard |

### IMPROVEMENT (new capabilities)

* **Side-by-side comparison table:** reported vs reconstructed for every field, including commitment and algorithm provenance. Shown in every verifier, in history and in reports.
* **Five-section evidence reports** (HTML/PDF): reconstruction, comparison, commitment, historical evidence and final assessment, plus provenance, limitations and trace.
* **Standalone reproduction script** per round: a self-contained Node.js file that recomputes the outcome without the Lab. Round data is embedded as JSON, never as code; an injection test is included.
* **Re-audit** (single record or bulk) with a kept **audit history** (`previous_audits_json`), plus a banner when today's settings would assess a record differently.
* **Seed Sessions** page (seed-pair manager): nonce ranges, versions, commitments, sources and conflicts.
* **Integrity checks:** 9 → 12, classified as **contradiction / anomaly / data quality**. New checks:
  * reused commitments across different seeds;
  * conflicting nonce reuse;
  * nonce resets;
  * missing reveal data;
  * invalid parameters.
* **Batch:** progress, pause, resume, cancel, a duplicates counter, outcome breakdown links, mismatch-only views and exports, and a re-run of the batch.
* **Trace regeneration:** every record shows "✓ recomputing reproduces the stored outcome".
* **HMAC inspector presets** that rebuild the exact HMAC step of each game (Keno and Mines v2 block *n*, Blackjack card *n*, Crash digest).
* **Algorithm comparison** explicitly labelled *exploratory*.
* **`npm run audit:all`:** one command, honest PASS / FAIL / SKIP summary.

## Introduced during the audit and caught before release

* **P-01:** the new rotation integrity check took **263 s at 10k rows** (a correlated subquery). The benchmark caught it, and per-query profiling pinpointed it. It was rewritten as a materialised CTE.
* **First v2 job runner:** 100k imports were slower than v1 (31.9 s). Diagnosed as random-key index thrashing in SQLite's default 2 MB page cache, and fixed (64 MB cache; redundant index dropped).
* The `audit:all` Python probe wrongly reported **SKIP** on Windows (`shell: true` mangled `-c`). It was fixed so the check really runs.

## Testing results (final run of `npm run audit:all`, 2026-10-19)

```
PASS  TypeScript (backend + frontend)
PASS  ESLint
PASS  Unit + reference-parity tests      92 passed
PASS  Independent Python parity run      2055 cases, 14167 comparisons
PASS  Integration tests                  48 passed
PASS  Production build
PASS  Browser tests (Playwright)         18 passed
PASS  Dependency audit (npm audit)       found 0 vulnerabilities
8 passed, 0 failed, 0 skipped
```

No test was deleted. Two v1 assertions were changed because the behaviour was deliberately corrected, and are marked in the tests:

* "commitment mismatch → `mismatch`" became `commitment_mismatch` (F-06);
* the overall label "Result matches, commitment unproven" became "…commitment **timing** unproven", the wording the specification requires.

The four v1 import tests were ported to the job API with their assertions intact.

## Remaining risks and open items

1. **No independent confirmation of Solpump's algorithms.** The highest-value next step is to verify a few genuine historical rounds whose outcomes were seen in Solpump's UI, and add them as fixtures.
2. **Commitment scheme unconfirmed.** Commitments are only *candidate*-compared until the user confirms the scheme in Settings.
3. **Timing evidence is never "verified".** No confirmed on-chain program or event format exists. The On-Chain page is generic and does not link transactions to rounds.
4. **Keno payouts are not verified** (no authentic tables).
5. **Large analytics:** stats and integrity block the event loop for 0.9–3.5 s on their first call at 100k rows (cached afterwards).
6. **Durability:** `synchronous=NORMAL` means an OS crash or power loss can drop the most recent commits; the database is never corrupted.
7. **No authentication** by design (single-user local tool). Protection relies on loopback binding plus Host/Origin checks. `HOST`/`SFL_ALLOWED_HOSTS` widen exposure and print a warning.
8. **No foreign keys or CHECK constraints** on existing tables. Adding them requires a table rebuild of user data; validation is enforced in the application layer instead (Zod schemas, migration-tested).
9. **Large JSON documents** (not CSV or JSONL) are still parsed with one `JSON.parse` call: up to ~300 ms for 50 MB.
10. **React re-render profiling** was not performed.
11. Dependencies stay on their current majors (React 18, Vite 6, Zod 3). Newer majors exist but no vulnerability requires them, and the upgrade risk was judged not worth it here.

## Reproduction instructions

```
git log --oneline              # 13699a2 = audited baseline
npm install
npm run audit:all              # every gate, honest summary -> docs/AUDIT_RESULTS.txt
npm run test:parity            # three-way parity run with counts
npm run bench -w backend       # performance numbers (1k/10k/100k)
```

To see a defect on v1, check out `13699a2` and copy `backend/tests/unit/regressions.test.ts` or `backend/tests/integration/security.test.ts` into it, adjusting the import paths from `../../src/` to `../src/`. This is how the "fails on v1" claims above were verified: 9 of 14 regression tests and 13 of 14 security tests fail on v1. The rest are guards that also pass on v1.
