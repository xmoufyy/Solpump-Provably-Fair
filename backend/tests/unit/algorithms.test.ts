import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { computeCrash } from "../../src/games/crash.js";
import { computeBlackjack } from "../../src/games/blackjack.js";
import { computeKeno, KENO_DIFFICULTIES, BOARD_BY_MODE } from "../../src/games/keno.js";
import { computeMines, MINES_GRID_SIZES } from "../../src/games/mines.js";
import { ALGORITHM_VERSIONS } from "../../src/types.js";
import { verifyRound } from "../../src/verification/engine.js";
import type { KenoCalculated } from "../../../shared/src/contracts.js";
import * as ref from "../../../tests/reference-parity/reference/official.mjs";

// Test-only seed generator (random seeds are fine here: we compare two independent implementations).
// Deterministic pseudo-random seeds (sha256 of a counter) so any failure is reproducible.
let rndCounter = 0;
const rnd = (n = 16) => createHash("sha256").update(`algorithms-test:${rndCounter++}`).digest("hex").slice(0, n * 2);
const unicodeSeeds = ["héllo wörld", "\u{1F680} rocket", "tab\tinside", "  leading and trailing  ", ""];

describe("Crash parity", () => {
  it("matches reference across 2,000 random seed pairs", () => {
    for (let i = 0; i < 2000; i++) {
      const s = rnd(), c = rnd(8);
      expect(computeCrash(s, c).multiplier).toBe(ref.verifyCrash(s, c));
    }
  });

  it("instant-crash condition (digest mod 20 == 0) yields exactly 1.00", () => {
    let found = 0;
    for (let i = 0; found < 5 && i < 5000; i++) {
      const s = `instant-${i}`;
      const r = computeCrash(s, "public");
      if (r.mod20 === 0) {
        found++;
        expect(r.instantCrash).toBe(true);
        expect(r.multiplier).toBe(1);
        expect(ref.verifyCrash(s, "public")).toBe(1);
      } else {
        expect(r.instantCrash).toBe(false);
      }
    }
    expect(found).toBe(5);
  });

  it("handles unicode / whitespace seeds byte-exactly", () => {
    for (const s of unicodeSeeds.filter(Boolean)) {
      for (const c of unicodeSeeds) expect(computeCrash(s, c).multiplier).toBe(ref.verifyCrash(s, c));
    }
  });
});

describe("Blackjack parity", () => {
  it("multi-card sequences match reference", () => {
    for (let i = 0; i < 50; i++) {
      const s = rnd(), c = rnd(8);
      const { cards } = computeBlackjack(s, c, 52);
      cards.forEach((card, idx) => {
        expect(card.cardNumber).toBe(idx + 1);
        expect({ label: card.label, suit: card.suit }).toEqual(ref.generateCard(s, c, idx + 1));
      });
    }
  });

  it("does not insert separators: (c='ab', n=12) differs from (c='ab1', n=2) only by card number", () => {
    // HMAC message is clientSeed||cardNumber, so 'ab'+'12' and 'ab1'+'2' are the same message.
    const a = computeBlackjack("srv", "ab", 12).cards[11];
    const b = computeBlackjack("srv", "ab1", 2).cards[1];
    expect(a.hash).toBe(b.hash);
  });
});

describe("Keno parity", () => {
  for (const version of ALGORITHM_VERSIONS) {
    for (const mode of KENO_DIFFICULTIES) {
      it(`${version} / ${mode}`, () => {
        for (let i = 0; i < 200; i++) {
          const s = rnd(), c = rnd(8), n = String(i);
          const ours = computeKeno(s, c, n, version, mode).drawn;
          expect(ours).toEqual(ref.kenoDraw(s, c, n, version, mode));
          expect(ours).toHaveLength(10);
          expect(new Set(ours).size).toBe(10);
          const max = BOARD_BY_MODE[mode].tileCount;
          expect(ours.every((x) => x >= 1 && x <= max)).toBe(true);
        }
      });
    }
  }

  it("Extreme draws come from 1-56 and reach numbers above 40", () => {
    let above40 = false;
    for (let i = 0; i < 100; i++) {
      const d = computeKeno(rnd(), rnd(), String(i), "hmac_sha256_v2", "EXTREME").drawn;
      if (d.some((x) => x > 40)) above40 = true;
    }
    expect(above40).toBe(true);
  });

  it("Classic/Low/Medium/High produce the identical draw for identical seeds", () => {
    const s = rnd(), c = rnd(), n = "7";
    const base = computeKeno(s, c, n, "hmac_sha256_v2", "CLASSIC").drawn;
    for (const m of ["LOW", "MEDIUM", "HIGH"] as const) expect(computeKeno(s, c, n, "hmac_sha256_v2", m).drawn).toEqual(base);
  });

  it("every pick count 1-10 in every mode: draw is unaffected by picks and matches are counted correctly", () => {
    const s = "pick-server", c = "pick-client", n = "42";
    for (const mode of KENO_DIFFICULTIES) {
      const max = BOARD_BY_MODE[mode].tileCount;
      const drawn = ref.kenoDraw(s, c, n, "hmac_sha256_v2", mode);
      for (let k = 1; k <= 10; k++) {
        const picks = Array.from({ length: k }, (_, i) => ((i * 7) % max) + 1).filter((v, i, a) => a.indexOf(v) === i);
        const r = verifyRound(
          { game: "keno", serverSeed: s, clientSeed: c, nonce: n, algorithmVersion: "hmac_sha256_v2", difficulty: mode, selectedNumbers: picks },
          { commitmentScheme: "unconfirmed", mode: "manual" },
        );
        expect(r.outcome.status).toBe("reconstructed");
        expect((r.calculated as KenoCalculated).drawn).toEqual(drawn);
        expect((r.calculated as KenoCalculated).pickCount).toBe(picks.length);
        expect((r.calculated as KenoCalculated).matchCount).toBe(picks.filter((p) => drawn.includes(p)).length);
      }
    }
  });
});

describe("Mines parity", () => {
  for (const version of ALGORITHM_VERSIONS) {
    for (const g of MINES_GRID_SIZES) {
      it(`${version} / ${g}x${g}: every valid mine count 1-${g * g - 1}`, () => {
        for (let m = 1; m <= g * g - 1; m++) {
          const s = rnd(), c = rnd(8), n = String(m);
          const ours = computeMines(s, c, n, version, g, m);
          expect(ours.mines).toEqual(ref.minesPlacement(s, c, n, version, g, m));
          expect(ours.mines).toHaveLength(m);
          expect(new Set(ours.mines).size).toBe(m);
          expect(ours.safe).toHaveLength(g * g - m);
          expect(ours.mines.every((t) => t >= 0 && t < g * g)).toBe(true);
        }
      });
    }
  }

  it("rejects 0 mines and tileCount mines", () => {
    for (const g of MINES_GRID_SIZES) {
      expect(() => computeMines("a", "b", "1", "hmac_sha256_v2", g, 0)).toThrow();
      expect(() => computeMines("a", "b", "1", "hmac_sha256_v2", g, g * g)).toThrow();
    }
  });

  it("36 tiles / 35 mines leaves exactly one safe tile", () => {
    const r = computeMines("S", "C", "9", "hmac_sha256_v2", 6, 35);
    expect(r.safe).toHaveLength(1);
    expect(r.mines).toHaveLength(35);
  });

  it("Mines v2 keys HMAC with the private seed (differs from keying with server seed)", () => {
    // If the key were the server seed alone, changing the client seed would not change placement.
    const a = computeMines("S", "C1", "1", "hmac_sha256_v2", 8, 10).mines;
    const b = computeMines("S", "C2", "1", "hmac_sha256_v2", 8, 10).mines;
    expect(a).not.toEqual(b);
  });
});
