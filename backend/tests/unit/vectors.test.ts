import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { computeCrash } from "../../src/games/crash.js";
import { generateCard } from "../../src/games/blackjack.js";
import { computeKeno } from "../../src/games/keno.js";
import { computeMines } from "../../src/games/mines.js";
import { encodePart } from "../../src/crypto/transcript.js";
import * as ref from "../../../tests/reference-parity/reference/official.mjs";

const fx = JSON.parse(readFileSync(new URL("../../../fixtures/synthetic-test-vectors.json", import.meta.url), "utf8"));
const { serverSeed, clientSeed, nonce } = fx.inputs;

describe("supplied synthetic test vectors", () => {
  it("Crash: HMAC and 1.25x", () => {
    const c = computeCrash(serverSeed, clientSeed);
    expect(c.digest).toBe(fx.crash.hmac);
    expect(c.multiplier).toBe(fx.crash.multiplier);
    expect(ref.verifyCrash(serverSeed, clientSeed)).toBe(fx.crash.multiplier);
  });

  it("Blackjack: card #1 is King of Clubs", () => {
    const c = generateCard(serverSeed, clientSeed, 1);
    expect(c.hash).toBe(fx.blackjack.hmac);
    expect({ label: c.label, suit: c.suit }).toEqual(fx.blackjack.card);
    expect(ref.generateCard(serverSeed, clientSeed, 1)).toEqual(fx.blackjack.card);
  });

  it("Keno v2 CLASSIC draw order", () => {
    expect(computeKeno(serverSeed, clientSeed, nonce, "hmac_sha256_v2", "CLASSIC").drawn).toEqual(fx.keno.drawn);
    expect(ref.kenoDraw(serverSeed, clientSeed, nonce, "hmac_sha256_v2", "CLASSIC")).toEqual(fx.keno.drawn);
  });

  it("Mines v2 5x5 with 3 mines", () => {
    expect(computeMines(serverSeed, clientSeed, nonce, "hmac_sha256_v2", 5, 3).mines).toEqual(fx.mines.mines);
    expect(ref.minesPlacement(serverSeed, clientSeed, nonce, "hmac_sha256_v2", 5, 3)).toEqual(fx.mines.mines);
  });
});

describe("encoding known answers (hand-derived)", () => {
  it("encodePart uses a 4-byte big-endian UTF-8 byte length", () => {
    expect(encodePart("keno").toString("hex")).toBe("000000046b656e6f");
    expect(encodePart("").toString("hex")).toBe("00000000");
    // "é" is 2 UTF-8 bytes, not 1 character
    expect(encodePart("é").toString("hex")).toBe("00000002c3a9");
  });

  it("RFC 4231 test case 2 HMAC-SHA256 (sanity check of the primitive)", async () => {
    const { hmacSha256Hex } = await import("../../src/crypto/hmac.js");
    expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("seed strings are never trimmed", () => {
    expect(computeCrash(" SERVER_TEST_2026", clientSeed).digest).not.toBe(fx.crash.hmac);
    expect(computeCrash(serverSeed, `${clientSeed}\n`).digest).not.toBe(fx.crash.hmac);
  });
});
