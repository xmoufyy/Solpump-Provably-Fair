# Changelog — 2.0.0 (2026-10-19)

This release is the result of a full repository audit (see `COMPREHENSIVE_AUDIT.md`). Finding IDs in brackets refer to that document.

## Verification correctness

* **Crash:** reported multipliers are compared exactly. v1 rounded both sides, so 1.254 counted as a match [F-01].
* **Mines:** reported positions are compared as multisets, with explicit duplicate and count checks [F-02].
* **New final assessment `commitment_mismatch`,** separate from a result mismatch [F-06]. Existing records are remapped by the migration.
* **Final assessment labels** now follow the specification: "Result matches, commitment timing unproven" and "Incomplete evidence".
* **Imports reject JSON numbers that lost digits** (nonce or round ID beyond 2^53) instead of silently changing them [F-05].
* **Imports:**
  * pretty-printed single JSON objects are accepted [F-07];
  * a Mines `mines` position list is recognised [F-08];
  * Excel's UTF-8 BOM is handled.
* **Reported values are never rounded for display** [F-09]; round IDs are never re-cased [F-10]; Mines evidence is stored exactly as entered, with its index base [F-11].
* **Reproducibility checks compare outcome-defining values,** so records from older versions are judged correctly [F-12].
* **Every verification now returns a side-by-side comparison** (`comparisons`): field, reported, reconstructed, status, note.

## Cryptographic assurance

* New `tests/reference-parity/` harness. It compares production, the unchanged JS reference, and an **independent Python implementation** (with its own seedrandom port) on 2,055 deterministic cases, reporting the first divergent step.
* 11 mutation tests, crafted rejection-sampling tests, HMAC block-counter boundary tests, and documented properties: colon ambiguity, the no-separator Blackjack message, and the instant-crash rate.
* Game modules can skip trace generation (`{ trace: false }`) and expose raw draw indices and block counts. The arithmetic itself is unchanged.

## Security

* **Host-header allow-list** (DNS-rebinding protection) and same-origin enforcement for state-changing requests. CORS removed [S-01, S-02].
* CSV formula neutralisation [S-03], literal LIKE search [S-04], 400 for bad parameters and masked internal errors [S-05], security headers and a script-free CSP for HTML reports [S-06].
* **Bounded inputs everywhere** [F-03, S-08]; http(s)-only RPC URL [S-07]; 8 MB cap, no redirects and typed parsing for RPC responses [S-09].
* A warning when binding to a non-loopback `HOST`; `SFL_ALLOWED_HOSTS` for deliberate exposure.

## Data layer

* **Versioned migrations** (`PRAGMA user_version`), an automatic backup before migrating non-empty databases, a tested `down` path, and refusal to open newer schemas.
* **Migration v1** adds:
  * fingerprints, for idempotent imports;
  * re-audit history;
  * a commitment column;
  * import job state;
  * seven indexes (one redundant v0 index dropped).

  It also backfills existing rows.
* **Compact storage for imported rows,** with notes, comparisons and the trace rebuilt on view: 2.4× smaller databases.
* WAL with `synchronous=NORMAL`, a 64 MB page cache and a prepared-statement cache.
* Consistent backups through `POST /api/backup` and Settings → "Create database backup".

## Imports and auditing

* **Background import jobs:**
  * time-sliced transactions and lazy CSV/JSONL parsing;
  * progress, pause, resume and cancel;
  * duplicate skipping;
  * per-outcome counts;
  * the first 1,000 rejected rows kept with line numbers.
* **Re-audit** of single records or filtered sets (`POST /api/rounds/:id/reverify?update=1`, `POST /api/rounds/reverify`). Previous audits are kept.
* **Integrity audit in SQL:** 12 checks classified as contradiction / anomaly / data quality, bounded output, cached until data changes.
* **Seed sessions** (`GET /api/sessions`).
* **Standalone per-round reproduction scripts** (`GET /api/rounds/:id/script`).
* **Reports:**
  * five evidence sections, comparison table, provenance and limitations (HTML/PDF);
  * CSV streamed for any size;
  * HTML/PDF limited to 1,000 rounds with a clear 413;
  * JSON includes traces up to 2,000 rounds.

## Frontend

* **Shared contracts** with the backend (`shared/src`); no duplicated types or parsers.
* **Route-level code splitting:** first-load JS 653 KB → 184 KB; Recharts only loads on the Dashboard.
* **Keno:** draw-order badges, raw indices, a pure pick reducer, ARIA labels and pressed states.
* **Mines:** provenance-preserving input, per-tile ARIA labels, raw indices.
* **Blackjack:** click-to-inspect card derivation.
* **Crash:** instant-crash explanation and a numbered formula.
* **History:** server-side summaries, outcome and batch filters, a debounced abortable search, and an accessible detail dialog (Escape closes, focus restored). The dialog adds re-audit, standalone script, exports, provenance and audit history.
* **Batch:** live job panel; large files are kept out of the textarea.
* **Seed Sessions** page; integrity findings classified by kind.
* **Tools:** HMAC inspector presets with uint32 breakdown; algorithm comparison labelled *exploratory*.
* **Settings:** schema and migration info, backup, re-audit all.
* **Accessibility:** visible focus, reduced motion, skip link, keyboard-navigable radio groups, labelled controls, errors linked to fields, live regions.

## Tooling

* **ESLint** (typescript-eslint, react-hooks). `any` is banned in application code, and so is `Math.random`.
* **Scripts:** `npm run typecheck | lint | test | test:integration | test:parity | test:e2e | build | bench | audit:all`.
* **`test.bat`** installs the Playwright browser and runs `audit:all`.
* **Tests:** 70 → 158, plus the three-way parity run. An authentic v1 database fixture (`fixtures/db/v1-schema0.db`) supports the migration tests.
* **Benchmark and profiling tools** in `backend/bench/`.
