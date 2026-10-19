/**
 * Regression tests for defects found in the v2 audit (docs/COMPREHENSIVE_AUDIT.md).
 * Each test was run against the v1 code first and failed; IDs match the audit findings.
 */
import { describe, expect, it } from "vitest";
import { verifyRound } from "../../src/verification/engine.js";
import { parseImport } from "../../src/imports/parse.js";

const manual = { commitmentScheme: "unconfirmed" as const, mode: "manual" as const };
const confirmed = { commitmentScheme: "sha256_utf8_hex" as const, mode: "manual" as const };
const S = "SERVER_TEST_2026", C = "CLIENT_TEST_2026"; // Crash = 1.25x, Mines 5x5/3 v2 nonce 1 = [0, 14, 22]

describe("F-01 Crash: reported multiplier compared after rounding", () => {
  it("1.254 is not 1.25 (v1 rounded both sides with toFixed(2) and reported a match)", () => {
    const r = verifyRound({ game: "crash", serverSeed: S, clientSeed: C, reported: { multiplier: 1.254 } }, manual);
    expect(r.outcome.status).toBe("mismatch");
  });
  it("1.249 is not 1.25", () => {
    expect(verifyRound({ game: "crash", serverSeed: S, clientSeed: C, reported: { multiplier: 1.249 } }, manual).outcome.status).toBe("mismatch");
  });
  it("exact 1.25 still matches", () => {
    expect(verifyRound({ game: "crash", serverSeed: S, clientSeed: C, reported: { multiplier: 1.25 } }, manual).outcome.status).toBe("match");
  });
});

describe("F-02 Mines: duplicate reported positions produced a false MATCH", () => {
  it("[0, 0, 14] does not match [0, 14, 22]", () => {
    const r = verifyRound(
      { game: "mines", serverSeed: S, clientSeed: C, nonce: "1", algorithmVersion: "hmac_sha256_v2", gridSize: 5, mineCount: 3, reported: { mines: [0, 0, 14] } },
      manual,
    );
    expect(r.outcome.status).toBe("mismatch");
  });
  it("[14, 22, 0] (other order) still matches", () => {
    const r = verifyRound(
      { game: "mines", serverSeed: S, clientSeed: C, nonce: "1", algorithmVersion: "hmac_sha256_v2", gridSize: 5, mineCount: 3, reported: { mines: [14, 22, 0] } },
      manual,
    );
    expect(r.outcome.status).toBe("match");
  });
});

describe("F-03 Unbounded work per request", () => {
  it("100,000 reported Blackjack cards are rejected instead of generating 100,000 HMACs", () => {
    const cards = Array.from({ length: 100000 }, () => ({ label: "K", suit: "clubs" }));
    const r = verifyRound({ game: "blackjack", serverSeed: S, clientSeed: C, cardCount: 1, reported: { cards } }, manual);
    expect(r.outcome.status).toBe("invalid_input");
  });
  it("a 1 MB seed is rejected with an explicit error (never silently truncated)", () => {
    const r = verifyRound({ game: "crash", serverSeed: "x".repeat(1_000_000), clientSeed: C }, manual);
    expect(r.outcome.status).toBe("invalid_input");
    expect(r.errors[0].field).toBe("serverSeed");
  });
  it("oversized pick / tile lists are rejected", () => {
    const big = Array.from({ length: 10000 }, (_, i) => i);
    expect(verifyRound({ game: "mines", serverSeed: S, clientSeed: C, nonce: "1", algorithmVersion: "hmac_sha256_v2", gridSize: 5, mineCount: 3, clickedTiles: big }, manual).outcome.status).toBe("invalid_input");
  });
});

describe("F-04 Import: UTF-8 BOM from Excel CSV exports swallowed the first column", () => {
  it("round_id survives a leading BOM", () => {
    const csv = `﻿round_id,game,server_seed,client_seed,reported_outcome\nr1,crash,${S},${C},1.25\n`;
    const { rows } = parseImport(csv, "csv");
    expect(rows[0].input?.roundId).toBe("r1");
  });
});

describe("F-05 Import: numeric JSON nonces beyond 2^53 silently changed", () => {
  it("nonce 9007199254740993 written as a JSON number is rejected, not rounded to ...992", () => {
    const text = `[{"game":"keno","serverSeed":"${S}","clientSeed":"${C}","nonce":9007199254740993,"algorithmVersion":"hmac_sha256_v2","difficulty":"CLASSIC"}]`;
    const { rows } = parseImport(text, "json");
    expect(rows[0].input?.nonce).not.toBe("9007199254740992");
    expect(rows[0].error).toMatch(/nonce/i);
  });
  it("the same nonce as a JSON string is preserved exactly", () => {
    const text = `[{"game":"keno","serverSeed":"${S}","clientSeed":"${C}","nonce":"9007199254740993","algorithmVersion":"hmac_sha256_v2","difficulty":"CLASSIC"}]`;
    expect(parseImport(text, "json").rows[0].input?.nonce).toBe("9007199254740993");
  });
});

describe("F-06 Final assessment: commitment mismatch was reported as a result mismatch", () => {
  it("matching outcome + wrong commitment (confirmed scheme) -> commitment_mismatch", () => {
    const r = verifyRound({ game: "crash", serverSeed: S, clientSeed: C, reported: { multiplier: 1.25 }, commitment: "00".repeat(32) }, confirmed);
    expect(r.outcome.status).toBe("match");
    expect(r.overall).toBe("commitment_mismatch");
  });
});

describe("F-07 Import: pretty-printed single JSON object was parsed line-by-line as JSONL", () => {
  it("a multi-line single object imports as one record", () => {
    const text = `{\n  "game": "crash",\n  "serverSeed": "${S}",\n  "clientSeed": "${C}"\n}`;
    const r = parseImport(text, "auto");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].input?.game).toBe("crash");
  });
});

describe("F-08 Import: Mines 'mines' given as a position array was read as the mine count", () => {
  it("mines: [0,14,22] is treated as reported positions", () => {
    const text = `[{"game":"mines","serverSeed":"${S}","clientSeed":"${C}","nonce":"1","algorithmVersion":"v2","gridSize":5,"mineCount":3,"mines":[0,14,22]}]`;
    const row = parseImport(text, "json").rows[0];
    expect(row.error).toBeUndefined();
    expect((row.input?.reported as { mines: number[] }).mines).toEqual([0, 14, 22]);
  });
});
