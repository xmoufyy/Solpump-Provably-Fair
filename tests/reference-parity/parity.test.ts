import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import seedrandom from "seedrandom";
import { buildCases, prodSteps, runParity, type Case, type Steps } from "./harness.js";
import { computeCrash } from "../../backend/src/games/crash.js";
import { computeKeno } from "../../backend/src/games/keno.js";
import { computeMines } from "../../backend/src/games/mines.js";
import { uniformIndex, rejectionLimit } from "../../backend/src/crypto/prng.js";
import { encodePart } from "../../backend/src/crypto/transcript.js";

const cases = buildCases();
const report = runParity(cases);

describe("three-way reference parity", () => {
  it("covers every algorithm with hundreds of deterministic cases", () => {
    for (const algo of ["crash", "blackjack", "keno_v2", "keno_v1", "mines_v2", "mines_v1"]) {
      expect(report.casesByAlgo[algo]).toBeGreaterThanOrEqual(300);
    }
  });

  it("production == unchanged JS reference on every case", () => {
    const jsDiv = report.divergences.filter((d) => d.step.startsWith("final:"));
    expect(jsDiv, JSON.stringify(jsDiv.slice(0, 3))).toEqual([]);
  });

  it.skipIf(!report.pythonAvailable)("production == independent Python implementation at every intermediate step", () => {
    const pyDiv = report.divergences.filter((d) => !d.step.startsWith("final:"));
    expect(pyDiv, JSON.stringify(pyDiv.slice(0, 3))).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------------
 * Mutation tests: plausible WRONG implementations must be detected, at the correct first step.
 * This proves the parity suite is sensitive and does not merely compare an implementation to itself.
 * ------------------------------------------------------------------------------------------- */
const hex = (key: string | Buffer, ...parts: (string | Buffer)[]) => {
  const m = createHmac("sha256", key);
  for (const p of parts) m.update(p);
  return m.digest("hex");
};
const E = 2 ** 52;
function crashMutant(c: Case, kind: "swap" | "h8" | "modOnH"): Steps {
  const digest = kind === "swap" ? hex(c.clientSeed, c.serverSeed) : hex(c.serverSeed, c.clientSeed);
  const h = parseInt(digest.slice(0, kind === "h8" ? 8 : 13), 16);
  const instant = kind === "modOnH" ? h % 20 === 0 : BigInt("0x" + digest) % 20n === 0n;
  const cents = instant ? 100 : Math.floor((100 * E - h) / (E - h));
  return [["digest", digest], ["instant", instant], ["h", instant && kind !== "modOnH" ? null : h], ["cents", cents], ["multiplier", cents / 100]];
}
function v2Indices(key: string, transcript: Buffer, ranges: number[], counterLE = false): number[] {
  let counter = 0, block = Buffer.alloc(0), off = 0;
  const next = () => {
    if (off + 4 > block.length) {
      const cb = Buffer.alloc(4);
      if (counterLE) cb.writeUInt32LE(counter++);
      else cb.writeUInt32BE(counter++);
      block = createHmac("sha256", key).update(transcript).update(cb).digest();
      off = 0;
    }
    const v = block.readUInt32BE(off);
    off += 4;
    return v;
  };
  return ranges.map((r) => uniformIndex(next, r));
}
const label = "solpump:provably-fair:hmac-sha256:v2";
const tr = (...p: string[]) => Buffer.concat(p.map(encodePart));
function drawFrom(n: number, k: number, idx: (remaining: number) => number, replace = false) {
  const pool = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [], indices: number[] = [];
  for (let i = 0; i < k; i++) {
    const j = idx(replace ? n : pool.length);
    indices.push(j);
    out.push(replace ? pool[j] : pool.splice(j, 1)[0]);
  }
  return { out, indices };
}
function kenoMutant(c: Case, kind: "minesKey" | "counterLE" | "withReplacement"): Steps {
  const tiles = c.difficulty === "EXTREME" ? 56 : 40;
  const t = tr(label, "keno", c.clientSeed, c.nonce!);
  const key = kind === "minesKey" ? `${c.serverSeed}:${c.clientSeed}:${c.nonce}` : c.serverSeed;
  let counter = 0;
  const ranges = Array.from({ length: 10 }, (_, i) => (kind === "withReplacement" ? tiles : tiles - i));
  const all = v2Indices(key, t, ranges, kind === "counterLE");
  const { out, indices } = drawFrom(tiles, 10, () => all[counter++], kind === "withReplacement");
  return [["indices", indices], ["drawn", out.map((x) => x + 1)]];
}
function minesMutant(c: Case, kind: "serverKey" | "realTranscript" | "legacyNoNonce"): Steps {
  const n = c.gridSize! * c.gridSize!;
  let idx: (r: number) => number;
  if (kind === "legacyNoNonce") {
    const rng = seedrandom(`${c.serverSeed}:${c.clientSeed}`);
    idx = (r) => Math.floor(rng() * r);
  } else {
    const key = kind === "serverKey" ? c.serverSeed : `${c.serverSeed}:${c.clientSeed}:${c.nonce}`;
    const t = kind === "realTranscript" ? tr(label, "mines", c.clientSeed, c.nonce!) : tr(label, "mines", "", "0");
    const ranges = Array.from({ length: c.mineCount! }, (_, i) => n - i);
    const all = v2Indices(key, t, ranges);
    let k = 0;
    idx = () => all[k++];
  }
  const { out, indices } = drawFrom(n, c.mineCount!, idx);
  return [["indices", indices], ["mines", out]];
}
function blackjackMutant(c: Case, kind: "separator" | "suitFromRank"): Steps {
  const L = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"], S = ["hearts", "diamonds", "clubs", "spades"];
  return Array.from({ length: c.cardCount! }, (_, i): Steps => {
    const hash = kind === "separator" ? hex(c.serverSeed, c.clientSeed, ":", `${i + 1}`) : hex(c.serverSeed, c.clientSeed, `${i + 1}`);
    const h = parseInt(hash.slice(0, 13), 16);
    const suit = kind === "suitFromRank" ? S[(h % 13) % 4] : S[h % 4];
    return [[`card${i + 1}.hash`, hash], [`card${i + 1}.h`, h], [`card${i + 1}.card`, `${L[h % 13]}/${suit}`]];
  }).flat();
}

/** minFraction: share of cases on which the mutant actually changes the result (some bugs only bite sometimes). */
const mutants: { name: string; algo: string; impl: (c: Case) => Steps; firstStep: RegExp; minFraction?: number; size?: number }[] = [
  { name: "Crash: HMAC key and message swapped", algo: "crash", impl: (c) => crashMutant(c, "swap"), firstStep: /^digest$/ },
  { name: "Crash: h from 8 hex chars instead of 13", algo: "crash", impl: (c) => crashMutant(c, "h8"), firstStep: /^h$/ },
  { name: "Crash: mod-20 test on h instead of the full digest", algo: "crash", impl: (c) => crashMutant(c, "modOnH"), firstStep: /^(instant|h)$/, minFraction: 0.04, size: 330 },
  { name: "Blackjack: ':' separator before card number", algo: "blackjack", impl: (c) => blackjackMutant(c, "separator"), firstStep: /^card1\.hash$/ },
  { name: "Blackjack: suit derived from rank index", algo: "blackjack", impl: (c) => blackjackMutant(c, "suitFromRank"), firstStep: /\.card$/, minFraction: 0.6 },
  { name: "Keno v2: HMAC keyed with Mines private seed", algo: "keno_v2", impl: (c) => kenoMutant(c, "minesKey"), firstStep: /^indices$/ },
  { name: "Keno v2: little-endian block counter", algo: "keno_v2", impl: (c) => kenoMutant(c, "counterLE"), firstStep: /^indices$/ },
  { name: "Keno v2: drawing with replacement", algo: "keno_v2", impl: (c) => kenoMutant(c, "withReplacement"), firstStep: /^indices$/ },
  { name: "Mines v2: HMAC keyed with server seed only", algo: "mines_v2", impl: (c) => minesMutant(c, "serverKey"), firstStep: /^indices$/ },
  { name: "Mines v2: client seed/nonce in transcript instead of literals", algo: "mines_v2", impl: (c) => minesMutant(c, "realTranscript"), firstStep: /^indices$/ },
  { name: "Mines v1: seedrandom seed without nonce", algo: "mines_v1", impl: (c) => minesMutant(c, "legacyNoNonce"), firstStep: /^indices$/ },
];

describe("mutation sensitivity (wrong implementations must be caught)", () => {
  for (const m of mutants) {
    it(m.name, () => {
      const subset = cases.filter((c) => c.algo === m.algo).slice(0, m.size ?? 60);
      const min = subset.length * (m.minFraction ?? 0.9);
      const r = runParity(subset, { prod: (c) => (c.algo === m.algo ? m.impl(c) : prodSteps(c)) });
      // essentially every case must diverge from the JS reference ...
      const finals = r.divergences.filter((d) => d.step.startsWith("final:"));
      expect(finals.length).toBeGreaterThan(min);
      // ... and the step-level comparison with Python must name the right first step
      if (r.pythonAvailable) {
        const steps = r.divergences.filter((d) => !d.step.startsWith("final:")).map((d) => d.step);
        expect(steps.length).toBeGreaterThan(min);
        expect(steps.every((s) => m.firstStep.test(s)), `first steps: ${[...new Set(steps)].join(",")}`).toBe(true);
      }
    });
  }
});

describe("rejection sampling (path too rare for random parity: p ~ 1e-8 per draw)", () => {
  it("limit is 2^32 - (2^32 mod max)", () => {
    expect(rejectionLimit(40)).toBe(4294967280); // 2^32 mod 40 = 16
    expect(rejectionLimit(56)).toBe(4294967264); // 2^32 mod 56 = 32
    expect(rejectionLimit(64)).toBe(2 ** 32); // power of two: nothing is ever rejected
    expect(rejectionLimit(1)).toBe(2 ** 32);
  });

  it("values >= limit are skipped and the next value is used", () => {
    const vals = [4294967280, 4294967295, 4294967279, 123];
    let i = 0;
    const seen: [number, boolean][] = [];
    const idx = uniformIndex(() => vals[i++], 40, (v, rej) => seen.push([v, rej]));
    expect(idx).toBe(4294967279 % 40);
    expect(seen).toEqual([[4294967280, true], [4294967295, true], [4294967279, false]]);
    expect(i).toBe(3); // 123 is never consumed
  });

  it("a rejected sample consumes a uint32 slot, shifting later draws (counter boundary)", () => {
    // 8 uint32 per block: forcing a rejection at the 8th value pushes the next draw into block 1.
    const vals = [1, 2, 3, 4, 5, 6, 7, 4294967295, 9, 10];
    let i = 0;
    const out = Array.from({ length: 9 }, () => uniformIndex(() => vals[i++], 40));
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 7, 9, 10]);
  });

  it("rejects ranges outside 1..2^32", () => {
    expect(() => rejectionLimit(0)).toThrow(RangeError);
    expect(() => rejectionLimit(2 ** 32 + 1)).toThrow(RangeError);
    expect(() => rejectionLimit(1.5)).toThrow(RangeError);
  });
});

describe("block counter boundaries", () => {
  it("Keno uses blocks 0 and 1 (10 draws, 8 uint32 per block)", () => {
    expect(computeKeno("s", "c", "1", "hmac_sha256_v2", "CLASSIC", { trace: false }).blockCount).toBe(2);
  });
  it("Mines 8x8 with 63 mines needs 8 blocks (63 values)", () => {
    expect(computeMines("s", "c", "1", "hmac_sha256_v2", 8, 63, { trace: false }).blockCount).toBe(8);
  });
  it("trace records the block counter and byte offset of every consumed value", () => {
    const r = computeMines("s", "c", "1", "hmac_sha256_v2", 3, 8);
    const blocks = r.trace.steps.filter((s) => s.section === "HMAC blocks");
    expect(blocks.map((b) => b.label)).toEqual(["Block counter 0"]);
    expect(r.trace.steps.filter((s) => s.section === "Placement")[7].value).toContain("[block 0 @ byte 28]");
  });
});

describe("documented properties of the published constructions", () => {
  it("Mines private seed is ambiguous under ':' (identical boards) - reproduced faithfully, not 'fixed'", () => {
    const a = computeMines("a:b", "c", "1", "hmac_sha256_v2", 5, 3, { trace: false }).mines;
    const b = computeMines("a", "b:c", "1", "hmac_sha256_v2", 5, 3, { trace: false }).mines;
    expect(a).toEqual(b);
  });
  it("Keno v2 is NOT ambiguous (length-prefixed transcript) but Keno v1 is", () => {
    const v2a = computeKeno("a", "b:c", "1", "hmac_sha256_v2", "CLASSIC", { trace: false }).drawn;
    const v2b = computeKeno("a", "b", "c:1", "hmac_sha256_v2", "CLASSIC", { trace: false }).drawn;
    expect(v2a).not.toEqual(v2b);
    const v1a = computeKeno("a", "b:c", "1", "seedrandom_v1", "CLASSIC", { trace: false }).drawn;
    const v1b = computeKeno("a", "b", "c:1", "seedrandom_v1", "CLASSIC", { trace: false }).drawn;
    expect(v1a).toEqual(v1b);
  });
  it("Crash instant-crash rate is ~1/20 over 20,000 deterministic seeds", () => {
    let n = 0;
    for (let i = 0; i < 20000; i++) if (computeCrash(`rate-${i}`, "p", { trace: false }).instantCrash) n++;
    expect(n / 20000).toBeGreaterThan(0.045);
    expect(n / 20000).toBeLessThan(0.055);
  });
});
