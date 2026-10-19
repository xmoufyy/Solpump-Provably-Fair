import { describe, expect, it } from "vitest";
import { verifyRound } from "../../src/verification/engine.js";
import { sha256Hex } from "../../src/crypto/hmac.js";

const manual = { commitmentScheme: "unconfirmed" as const, mode: "manual" as const };
const confirmed = { commitmentScheme: "sha256_utf8_hex" as const, mode: "manual" as const };
const S = "SERVER_TEST_2026", C = "CLIENT_TEST_2026";

describe("verification status engine", () => {
  it("reconstruction without a reported outcome is never labelled verified", () => {
    const r = verifyRound({ game: "crash", serverSeed: S, clientSeed: C }, manual);
    expect(r.outcome.status).toBe("reconstructed");
    expect(r.overall).toBe("reconstructed_only");
  });

  it("imported records without an outcome are 'missing comparison'", () => {
    const r = verifyRound({ game: "crash", serverSeed: S, clientSeed: C }, { ...manual, mode: "import" });
    expect(r.outcome.status).toBe("missing_comparison");
  });

  it("match + unconfirmed commitment scheme -> match, commitment unproven", () => {
    const r = verifyRound({ game: "crash", serverSeed: S, clientSeed: C, reported: { multiplier: 1.25 }, commitment: sha256Hex(S) }, manual);
    expect(r.outcome.status).toBe("match");
    expect(r.commitment.status).toBe("scheme_unconfirmed");
    expect(r.overall).toBe("match_commitment_unproven");
  });

  it("match + confirmed scheme still lacks timing evidence -> not 'verified with sufficient evidence'", () => {
    const r = verifyRound({ game: "crash", serverSeed: S, clientSeed: C, reported: { multiplier: 1.25 }, commitment: sha256Hex(S) }, confirmed);
    expect(r.commitment.status).toBe("verified");
    expect(r.timing.status).toBe("publication_timing_unverified");
    expect(r.overall).toBe("match_commitment_unproven");
  });

  it("commitment mismatch under confirmed scheme -> overall mismatch", () => {
    const r = verifyRound({ game: "crash", serverSeed: S, clientSeed: C, reported: { multiplier: 1.25 }, commitment: "00".repeat(32) }, confirmed);
    expect(r.commitment.status).toBe("mismatch");
    expect(r.overall).toBe("mismatch");
  });

  it("wrong multiplier -> mismatch", () => {
    const r = verifyRound({ game: "crash", serverSeed: S, clientSeed: C, reported: { multiplier: 2.5 } }, manual);
    expect(r.outcome.status).toBe("mismatch");
    expect(r.overall).toBe("mismatch");
  });

  it("blackjack compares reported cards positionally", () => {
    const ok = verifyRound({ game: "blackjack", serverSeed: S, clientSeed: C, cardCount: 1, reported: { cards: [{ label: "K", suit: "clubs" }] } }, manual);
    expect(ok.outcome.status).toBe("match");
    const bad = verifyRound({ game: "blackjack", serverSeed: S, clientSeed: C, cardCount: 1, reported: { cards: [{ label: "A", suit: "clubs" }] } }, manual);
    expect(bad.outcome.status).toBe("mismatch");
  });

  it("keno: missing algorithm version is invalid, unknown version is unsupported", () => {
    const missing = verifyRound({ game: "keno", serverSeed: S, clientSeed: C, nonce: "1", difficulty: "CLASSIC" }, manual);
    expect(missing.outcome.status).toBe("invalid_input");
    const unknown = verifyRound({ game: "keno", serverSeed: S, clientSeed: C, nonce: "1", difficulty: "CLASSIC", algorithmVersion: "v3" }, manual);
    expect(unknown.outcome.status).toBe("unsupported_version");
    expect(unknown.overall).toBe("unsupported");
  });

  it("keno: 11 picks, duplicates and out-of-board picks are rejected", () => {
    const base = { game: "keno", serverSeed: S, clientSeed: C, nonce: "1", difficulty: "CLASSIC", algorithmVersion: "hmac_sha256_v2" };
    expect(verifyRound({ ...base, selectedNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }, manual).outcome.status).toBe("invalid_input");
    expect(verifyRound({ ...base, selectedNumbers: [1, 1] }, manual).outcome.status).toBe("invalid_input");
    expect(verifyRound({ ...base, selectedNumbers: [41] }, manual).outcome.status).toBe("invalid_input");
    expect(verifyRound({ ...base, difficulty: "EXTREME", selectedNumbers: [56] }, manual).outcome.status).toBe("reconstructed");
  });

  it("keno: reported draw match in any order; wrong draw is a mismatch", () => {
    const base = { game: "keno", serverSeed: S, clientSeed: C, nonce: "1", difficulty: "CLASSIC", algorithmVersion: "hmac_sha256_v2", selectedNumbers: [27, 3] };
    const r = verifyRound({ ...base, reported: { draw: [1, 2, 8, 10, 19, 20, 27, 29, 35, 37] } }, manual);
    expect(r.outcome.status).toBe("match");
    expect(r.calculated!.orderMatches).toBe(false);
    expect(r.calculated!.matched).toEqual([27]);
    const bad = verifyRound({ ...base, reported: { draw: [1, 2, 8, 10, 19, 20, 27, 29, 35, 38] } }, manual);
    expect(bad.outcome.status).toBe("mismatch");
  });

  it("keno payout verification is reported unavailable", () => {
    const r = verifyRound({ game: "keno", serverSeed: S, clientSeed: C, nonce: "1", difficulty: "LOW", algorithmVersion: "hmac_sha256_v2", selectedNumbers: [5] }, manual);
    expect(r.payout?.status).toBe("unavailable");
  });

  it("mines: one-based reported positions are converted only when indexBase=1", () => {
    const base = { game: "mines", serverSeed: S, clientSeed: C, nonce: "1", algorithmVersion: "hmac_sha256_v2", gridSize: 5, mineCount: 3 };
    expect(verifyRound({ ...base, reported: { mines: [0, 14, 22] } }, manual).outcome.status).toBe("match");
    expect(verifyRound({ ...base, indexBase: 1, reported: { mines: [1, 15, 23] } }, manual).outcome.status).toBe("match");
    expect(verifyRound({ ...base, reported: { mines: [1, 15, 23] } }, manual).outcome.status).toBe("mismatch");
  });

  it("mines: clicked tiles determine win/loss consistency", () => {
    const base = { game: "mines", serverSeed: S, clientSeed: C, nonce: "1", algorithmVersion: "hmac_sha256_v2", gridSize: 5, mineCount: 3 };
    const loss = verifyRound({ ...base, clickedTiles: [3, 14], reported: { outcome: "loss" } }, manual);
    expect(loss.outcome.status).toBe("match");
    expect(loss.calculated!.clickedMines).toEqual([14]);
    const wrong = verifyRound({ ...base, clickedTiles: [3, 4], reported: { outcome: "loss" } }, manual);
    expect(wrong.outcome.status).toBe("mismatch");
  });

  it("mines: invalid grid and mine counts", () => {
    const base = { game: "mines", serverSeed: S, clientSeed: C, nonce: "1", algorithmVersion: "hmac_sha256_v2" };
    expect(verifyRound({ ...base, gridSize: 4, mineCount: 3 }, manual).outcome.status).toBe("invalid_input");
    expect(verifyRound({ ...base, gridSize: 3, mineCount: 9 }, manual).outcome.status).toBe("invalid_input");
    expect(verifyRound({ ...base, gridSize: 8, mineCount: 63 }, manual).outcome.status).toBe("reconstructed");
  });

  it("empty server seed is invalid input", () => {
    const r = verifyRound({ game: "crash", serverSeed: "", clientSeed: C }, manual);
    expect(r.outcome.status).toBe("invalid_input");
    expect(r.errors[0].field).toBe("serverSeed");
  });
});
