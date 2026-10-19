# Algorithm source status

| Game | Implemented version(s) | Source used | Checked against live page? |
|---|---|---|---|
| Crash | `crash_hmac_sha256_v1` | Reference code in project spec | No: page was behind a bot check on 2026-10-19 |
| Blackjack | `blackjack_hmac_sha256_card_v1` | Reference code in project spec | No: as above |
| Keno | `hmac_sha256_v2`, `seedrandom_v1` | Reference code in project spec | No: as above |
| Mines | `hmac_sha256_v2`, `seedrandom_v1` | Reference code in project spec | No: as above |
| Commitment | candidate `SHA-256(UTF-8 serverSeed)` | **Unconfirmed**, off by default | No |
| Keno payouts | not implemented | No authentic table available | No |
| On-chain | generic tx lookup only | No confirmed program/event spec | No |

## Procedure when Solpump publishes a change

1. Save a dated copy of the new reference code under `docs/`.
2. Add the new version string to `ALGORITHM_VERSIONS` (`backend/src/types.ts`) and implement it next to the existing one. **Do not edit the existing version.**
3. Add the new code verbatim to `backend/tests/reference/official.mjs` and add parity tests.
4. Add at least one genuine historical round, with the outcome as shown by Solpump, as a fixture.
