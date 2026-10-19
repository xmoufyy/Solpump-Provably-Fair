# Performance report

All numbers were measured on the same machine (Windows 10, Node.js 22.23.2, local disk D:) with `backend/bench/bench.ts`.

* The benchmark uses **deterministic** mixed-game rows: 25% each of Crash, Blackjack, Keno and Mines, both algorithm versions, with reported outcomes produced by the reference implementation.
* It imports them into a throw-away database through the real HTTP API (`app.inject`).
* While the import runs, a 20 ms timer measures **event-loop stalls**: the longest time any other request would have to wait.

Raw output: [`bench/baseline.json`](bench/baseline.json) (v1 code at `13699a2`) and [`bench/after.json`](bench/after.json) (v2).

Reproduce:

```
npm run bench -w backend -- --sizes 1000,10000,100000 --out result.json
```

## Responsiveness during import (the main problem in v1)

| Rows | v1 longest stall | v2 longest stall |
|---:|---:|---:|
| 1,000 | 243 ms | 93 ms |
| 10,000 | **2,248 ms** | 151 ms |
| 100,000 | **19,120 ms** | 242 ms |

v1 verified the whole file inside one request handler, so the UI and every other API call froze for the whole import.

v2 runs imports as background jobs:

* **Time-sliced transactions:** each slice commits after at most about 100 ms of work or 2,000 rows.
* **Yielding:** the event loop is released between slices.
* **Lazy parsing:** CSV and JSONL are parsed inside the slices, not up front.

The remaining 150–250 ms peaks are single slices that include a WAL checkpoint.

## Import throughput, memory, database size

| Rows | Import time v1 → v2 | Peak RSS growth v1 → v2 | Database size v1 → v2 |
|---:|---:|---:|---:|
| 1,000 | 0.28 s → **0.17 s** | 10 → 6 MB | 5.6 → **2.3 MB** |
| 10,000 | 2.27 s → **1.42 s** | 48 → 31 MB | 55.5 → **22.7 MB** |
| 100,000 | 19.1 s → 21.0 s | 232 → **145 MB** | 555.7 → **230.4 MB** |

v2 does more work per row than v1:

* duplicate detection: a fingerprint lookup per row;
* eight maintained indexes instead of two;
* the commitment column.

At 100k rows that extra work roughly cancels out the other gains, so the total import time is about the same as v1 (+10%). The difference is that it is now background work that never blocks the app.

What moved the numbers during the audit, as measured by CPU profiles (`bench/profile-import.ts`, 20k rows):

| Change | 20k-row import |
|---|---:|
| Initial v2 job runner (500-row chunks, every SQL statement recompiled per row) | 5.17 s |
| Prepared-statement cache + `synchronous=NORMAL` (WAL) | 5.09 s |
| Compact storage for imported rows (no repeated notes, comparisons or trace; rebuilt on view) | 3.77 s |
| Time-sliced chunks (fixed sizes measured: 250 = 4.77 s, 1,000 = 3.91 s, 2,000 = 3.44 s, but 2,000-row chunks stall about 350 ms) | 3.76 s |
| 64 MB page cache (random fingerprint keys made index pages thrash beyond ~50k rows) + dropping the redundant `game` index | 100k: 31.9 s → **23.0 s** (this run) / **21.0 s** (final run) |

Durability trade-off: with WAL + `synchronous=NORMAL`, an **application** crash loses nothing and the database cannot be corrupted. An **operating-system crash or power loss** can lose the most recent commits.

## Queries

Times are for the first request after an import. Repeat requests are served from a cache keyed on a write counter (measured: **0.5 ms** at 100k rows) until the data changes.

| Query | 10k v1 → v2 | 100k v1 → v2 | Response size at 100k v1 → v2 |
|---|---:|---:|---:|
| Dashboard stats | 364 → **19 ms** | 4,835 → **939 ms** | 2.5 KB → 2.5 KB |
| Integrity audit | 412 → **111 ms** | 5,455 → **3,508 ms** | **29.6 MB → 2.5 KB** |
| History page (50 rows) | 5 → 1 ms | 41 → **2 ms** | **238 KB → 31 KB** |
| History search | 36 → 6 ms | 373 → 269 ms | 235 KB → 31 KB |
| History status filter | 28 → 0 ms | 312 → **1 ms** | — |
| CSV export (all rows) | 374 → 169 ms | 4,462 → **1,875 ms** | streamed, flat memory |

Notes:

* The **integrity audit** now runs **12 checks** (v1: 9) as SQL aggregations instead of JSON-parsing every row in JavaScript. Its output is bounded to 200 record IDs per finding with true totals.
* **During the audit a regression was introduced and caught by this benchmark.** The new rotation check used a correlated `NOT EXISTS` and took **263 s at 10k rows** (O(n²)). It was rewritten with a materialised CTE (7.06 s → 0.17 s at 4k rows), and the six status checks were merged into one table scan. Per-query timings were taken with `bench/profile-integrity.ts`.
* **History search** still scans with `LIKE '%…%'`; that is a substring search over five columns, so no B-tree index can serve it.
* **Stats and integrity at 100k rows** still block the event loop for 0.9–3.5 s on their first call after a change. Worker threads were considered but not used: these are explicit user actions on very large datasets, and the cache removes repeat costs. This is a remaining improvement opportunity.

## Verifier throughput (single thread, including trace generation)

| Game | v1 | v2 |
|---|---:|---:|
| Crash | 39.7k/s | 42.6k/s |
| Blackjack (10 cards) | 20.5k/s | 24.1k/s |
| Keno (Extreme) | 24.2k/s | 24.7k/s |
| Mines 8×8 / 63 mines | 13.1k/s | 11.7k/s |

There is no meaningful change (±10% run-to-run noise). The cryptographic code was deliberately left structurally identical.

Imports now skip trace generation entirely. The trace is regenerated deterministically when a record is opened, and the detail view checks that the regeneration reproduces the stored outcome.

## Frontend

| Metric | v1 | v2 |
|---|---:|---:|
| JavaScript on first load | 653.7 KB (188 KB gzip), single chunk | **184.5 KB (60 KB gzip)** + the route's own chunk |
| Verifier page total (e.g. Keno) | 653.7 KB | ~213 KB (index + shared verification components + page) |
| Dashboard (Recharts) | included in every page | 399.6 KB, loaded only when the Dashboard is opened |
| Importing a 1.3 MB file | rendered into a controlled `<textarea>` (Playwright `fill` timed out after 30 s) | files over 200 KB are held in memory and summarised; instant |
| History table | 50 full results (~230 KB per page) | 50 summaries (~31 KB) |

Virtualisation was not added: history is already paginated server-side (50 rows), and sessions likewise. Memoisation was applied where values are derived from large inputs (parsed lists, trace filtering).

React re-render profiling was **not** performed. The largest rendered structures (64 Mines tiles, 56 Keno tiles, 520 cards maximum) are small, but this is unmeasured.
