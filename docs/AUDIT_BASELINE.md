# Audit baseline

* **Baseline commit:** `13699a2` ("Baseline: Solpump Fairness Lab v1 (pre-audit snapshot)"). The project was not under version control before the audit; the repository was initialised and the untouched v1 tree committed first.
* **Date:** 2026-10-19
* **Environment:** Windows 10 (19045), Node.js v22.23.2, npm 10.9.8, Python 3.14.5

## Build and check status (before any change)

| Check | Result |
|---|---|
| `npm run typecheck` (backend + frontend, `strict: true`) | 0 errors |
| Lint | **No linter configured** |
| Vitest | 4 files, **62 passed**, 0 failed |
| Playwright | 8 passed (last run of v1) |
| `npm run build` | OK. Single JS chunk **653,703 B** (187 KB gzip), CSS 34 KB |
| `npm audit` | 0 known vulnerabilities |
| `npm outdated` | Majors available for React 19, Vite 8, Zod 4, Recharts 3, TS 7, lucide 1.x (none needed for correctness) |
| Database | Schema "v1" with no version marker (`PRAGMA user_version = 0`), no migration system. User DB `data/fairness-lab.db` had **0 rounds / 0 imports** at audit time |

## Feature inventory (v1)

* **Verifiers:** Crash, Blackjack, Keno (5 modes, v2 and legacy), Mines (5 grids, v2 and legacy)
* **Status engine:** outcome, commitment, timing and overall statuses
* **Audit:** round history (SQLite), batch import (CSV/JSON/JSONL, synchronous), seed-integrity checks, dashboard stats and charts
* **Tools:** HMAC inspector, algorithm comparison, exports (CSV/JSON/HTML/PDF), settings
* **On-chain:** generic read-only Solana transaction lookup

## Baseline performance

Measured with `backend/bench/bench.ts`, which uses deterministic rows and a throw-away database. Raw output is in [`docs/bench/baseline.json`](bench/baseline.json).

| Metric | 1k rows | 10k rows | 100k rows |
|---|---:|---:|---:|
| Import time (one blocking request) | 0.29 s | 2.27 s | **20.7 s** |
| Import throughput | 3.4k rows/s | 4.4k rows/s | 4.8k rows/s |
| Database size | 5.6 MB | 55.5 MB | **556 MB** |
| `GET /api/stats` | 38 ms | 383 ms | **4.9 s** |
| `GET /api/integrity` | 33 ms | 402 ms | **5.2 s, 29.6 MB response** |
| History page (50 rows) payload | 227 KB | 232 KB | 238 KB |
| History search | 6 ms | 37 ms | 357 ms |
| CSV export | 35 ms | 367 ms | 4.5 s |

Verifier throughput (single thread, including trace):

| Game | Rounds per second |
|---|---:|
| Crash | 40k |
| Blackjack (10 cards) | 23k |
| Keno | 24k |
| Mines 8×8 / 63 mines | 12k |

## Major bottlenecks identified

1. The import runs synchronously in one request, so the whole server (UI included) is unresponsive for its duration.
2. Every stored round duplicates its inputs and outcome and stores the full cryptographic trace, about 5.5 KB per row.
3. Stats and integrity load **every row and JSON-parse every `result_json`** in JavaScript.
4. History list responses include full results and traces for every row.
5. There is no index on `overall_status`, `outcome_status`, `import_batch_id` or the seed columns.

## Independent-source status

* `solpump.io/fairness/*` still returns a bot-verification challenge to both automated fetch and the built-in browser (re-checked 2026-10-19). It was not bypassed.
* Web searches found no public copy of Solpump's verifier code. Third-party pages describe other casinos' schemes and are **not** evidence for Solpump.
* Algorithms therefore remain sourced from the reference code in the project specification.
