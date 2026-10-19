# Cryptographic parity report

**Date:** 2026-10-19 · **Code:** Solpump Fairness Lab 2.0.0 · **Environment:** Node.js 22.23.2 (OpenSSL), Python 3.14.5

## Bottom line

* The production verifiers produce **exactly the same results as the published reference code** supplied with the project. This holds on every one of 2,055 deterministic cases, at every intermediate step.
* They also agree with an **independent second-language implementation**: Python, using its own HMAC/SHA-256 and a from-scratch port of `seedrandom`.
* The suite **catches all 11 plausible wrong implementations** it was tested against, each at the correct first-divergence step.
* **No defect was found in any of the four game algorithms**, in either the current (`hmac_sha256_v2`) or the legacy (`seedrandom_v1`) variant.

> **What this does *not* establish.** Solpump's live fairness pages (`solpump.io/fairness/{crash,blackjack,keno,mines}`) returned a bot-verification challenge on every attempt. That covers automated fetch on 2026-10-18 and 2026-10-19 and the built-in browser on both days, and the challenge was not bypassed. No public copy of Solpump's verifier code was found, and no genuine historical Solpump round with a known outcome was available.
>
> Parity is therefore with the **reference code supplied in the project specification**, not with Solpump's live documentation or live rounds. **No external confirmation exists.** The first real-world check should be a handful of your own historical rounds.

## Implementations compared

| ID | Implementation | Language / crypto | Independence |
|---|---|---|---|
| `prod` | `backend/src/games/*.ts` + `crypto/prng.ts` | TypeScript, Node `crypto` (OpenSSL) | What the application runs |
| `refjs` | `tests/reference-parity/reference/official.mjs` | JavaScript, Node `crypto`, npm `seedrandom@3.0.5` | Unchanged transcription of the published reference code; shares no code with `prod` |
| `py` | `tests/reference-parity/reference/independent.py` | Python, `hmac`/`hashlib`, own ARC4 port of seedrandom | Written from the algorithm descriptions; different language, different crypto library, different PRNG implementation |

The `py` seedrandom port reproduces seedrandom 3.0.5's default generator: `mixkey` over UTF-16 code units → RC4 key schedule → RC4-drop[256] → 52-bit double assembly. On the very first run it matched the npm package on the legacy Keno vector (`15, 14, 20, 13, 39, 30, 10, 7, 12, 6`). It then agreed on all 697 legacy cases.

## How cases are generated

Cases are built by `tests/reference-parity/harness.ts`:

* **Deterministic:** seeds are SHA-256 of a counter, with no `Math.random`, so any failure is reproducible.
* **Varied lengths:** server seeds of 8–64 characters and client seeds of 1–33.
* **Edge-case seeds** (15 strings), each used in **both** seed positions:
  * empty;
  * Latin-1 (2-byte UTF-8);
  * CJK (3-byte);
  * astral emoji (4-byte UTF-8 / UTF-16 surrogate pairs);
  * combining marks;
  * colons;
  * leading/trailing spaces;
  * tab/CR/LF;
  * NUL;
  * a 64-character hex string;
  * keys of 63, 64 and 65 bytes (the HMAC block-size boundary, where keys longer than 64 bytes are hashed first);
  * 1,000 characters;
  * quotes and backslashes.
* **Edge-case nonces** (11): `0`, `1`, `9`, `10`, `4294967295`, `4294967296`, `9007199254740993` (2^53+1), `18446744073709551615` (2^64−1), `abc`, `" 1"`, `"1 "`.
* **Every Keno mode** (Classic, Low, Medium, High, Extreme) in both versions.
* **Every Mines grid** (3×3, 5×5, 6×6, 7×7, 8×8) at the **minimum and maximum** mine count, in both versions.
* A **416-card** Blackjack sequence.

| Algorithm | Cases | Steps compared |
|---|---:|---|
| Crash | 330 | digest → instant-crash flag → `h` → `floor(...)` → multiplier |
| Blackjack | 331 (incl. one with 416 cards) | per card: hash → `h` → rank/suit |
| Keno `hmac_sha256_v2` | 346 | raw indices → drawn numbers |
| Keno `seedrandom_v1` | 346 | raw indices → drawn numbers |
| Mines `hmac_sha256_v2` | 351 | raw indices → mine positions |
| Mines `seedrandom_v1` | 351 | raw indices → mine positions |
| **Total** | **2,055 cases** | **14,167 comparisons, 0 divergences** |

The backend unit suite (`backend/tests/unit/algorithms.test.ts`) additionally covers:

* every valid mine count on every grid in both versions (356 board configurations);
* 200 seeds per Keno mode and version;
* every Keno pick count 1–10 in every mode.

## Supplied synthetic test vectors

These were supplied with the project; they are **not** real Solpump rounds.

| Vector | Expected | `prod` | `refjs` | `py` |
|---|---|---|---|---|
| Crash HMAC | `34378d55…66b165` | ✓ | ✓ | ✓ |
| Crash multiplier | 1.25x | ✓ | ✓ | ✓ (cents = 125) |
| Blackjack card 1 HMAC | `044d4627…e094f1` | ✓ | ✓ | ✓ |
| Blackjack card 1 | King of Clubs | ✓ | ✓ | ✓ |
| Keno v2 Classic | 27, 35, 20, 8, 1, 29, 37, 2, 19, 10 | ✓ | ✓ | ✓ |
| Mines v2 5×5/3 | 0, 14, 22 | ✓ | ✓ | ✓ |

All supplied vectors are correct, so none needed correcting. Additional known-answer checks cover RFC 4231 test case 2 (HMAC-SHA256) and hand-derived transcript encodings: `encodePart("keno") = 000000046b656e6f`, `encodePart("") = 00000000`, `encodePart("é") = 00000002c3a9`.

## Mutation sensitivity (proof the suite can fail)

Each mutant is a plausible implementation bug. The harness ran it in place of `prod` and had to report divergences, naming the correct **first** divergent step, on at least the stated share of cases.

| Mutant | First step reported | Detected on |
|---|---|---|
| Crash: HMAC key/message swapped | `digest` | ≥ 90% of cases |
| Crash: `h` from 8 hex chars instead of 13 | `h` | ≥ 90% |
| Crash: mod-20 test on `h` instead of the full digest | `instant` / `h` | ≥ 4% (only differs when one remainder is 0, about 10% of seeds) |
| Blackjack: `:` separator before card number | `card1.hash` | ≥ 90% |
| Blackjack: suit derived from rank index | `cardN.card` | ≥ 60% (a 1-card case can match by chance) |
| Keno v2: HMAC keyed with Mines' private seed | `indices` | ≥ 90% |
| Keno v2: little-endian block counter | `indices` (draws 9–10, block 1) | ≥ 90% |
| Keno v2: drawing with replacement | `indices` | ≥ 90% |
| Mines v2: keyed with server seed only | `indices` | ≥ 90% |
| Mines v2: client seed/nonce in transcript instead of literal `""`/`"0"` | `indices` | ≥ 90% |
| Mines v1: seedrandom seed without nonce | `indices` | ≥ 90% |

**All 11 mutants were killed.**

**A mutant that random testing cannot catch:** "no rejection sampling" (plain `v mod max`). Rejection happens with probability at most 2^32 mod max ÷ 2^32, at most 7.5×10⁻⁹ per draw for max ≤ 64. So that mutant survives random parity, as expected. The rejection path is instead covered by crafted-value unit tests:

* `rejectionLimit(40) = 4294967280`, `(56) = 4294967264`, `(64) = 2^32` (never rejects);
* values at or above the limit are skipped, and the next value is used;
* a rejected sample consumes a `uint32` slot, shifting later draws into the next HMAC block;
* invalid ranges throw.

## Properties of the published constructions (reproduced, not "fixed")

* **Mines and legacy Keno seeds are ambiguous under `:`.** `("a:b","c")` and `("a","b:c")` give the same private seed and therefore the same board. Keno v2 is not ambiguous, because its transcript is length-prefixed. Tests assert both behaviours.
* **Blackjack has no separator,** so client seed `"ab"` with card 12 hashes the same message as `"ab1"` with card 2. This is tested.
* **Crash:** the instant-crash rate measured over 20,000 deterministic seeds is within 4.5–5.5%, consistent with 1/20.
* **Crash has no nonce, and Blackjack has no nonce or shuffle;** duplicates are possible. The lab adds neither.

## Comparison semantics fixed during the audit

These are not algorithm bugs, but they changed verdicts. See `COMPREHENSIVE_AUDIT.md`.

* **Crash multipliers are now compared exactly.** v1 rounded both sides with `toFixed(2)`, so 1.254 "matched" 1.25.
* **Mines reported positions are compared as multisets.** v1's set check let `[0,0,14]` "match" `[0,14,22]`.
* **Reproducibility is judged on outcome-defining values only:** the multiplier, card sequence, draw or mine positions. Auxiliary fields added in later versions don't cause false "not reproduced" results.

## Unresolved compatibility concerns

1. **No external confirmation.** See the note at the top.
2. **Commitment scheme unknown.** SHA-256(UTF-8 server seed) is offered as a *candidate* and stays "unconfirmed" by default.
3. **Lone UTF-16 surrogates** in seeds are encoded by Node as U+FFFD (`EF BF BD`). This was not cross-checked in Python, which refuses to encode them, and it is unlikely to occur in real seeds.
4. **The legacy algorithm depends on `seedrandom@3.0.5`.** The version is pinned exactly in `backend/package.json`, and the Python port is pinned to its behaviour.

## Reproduce

```
npm run test:parity      # prints the case/comparison counts; exit 1 on any divergence
npm test                 # includes tests/reference-parity/parity.test.ts (mutations, rejection, counters)
```
