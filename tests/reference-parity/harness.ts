/**
 * Reference-parity harness.
 *
 * Three implementations are run on identical, deterministic inputs:
 *   prod   - backend/src/games/*.ts (what the application uses)
 *   refjs  - reference/official.mjs  (unchanged transcription of the published JS reference code)
 *   py     - reference/independent.py (independent Python implementation, incl. a from-scratch seedrandom port)
 *
 * For each case the harness compares intermediate values in calculation order
 * (digest -> extracted integer -> indices -> final result) and reports the FIRST step
 * at which any two implementations diverge.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeCrash } from "../../backend/src/games/crash.js";
import { computeBlackjack } from "../../backend/src/games/blackjack.js";
import { computeKeno } from "../../backend/src/games/keno.js";
import { computeMines } from "../../backend/src/games/mines.js";
import * as ref from "./reference/official.mjs";

export type Algo = "crash" | "blackjack" | "keno_v2" | "keno_v1" | "mines_v2" | "mines_v1";
export interface Case {
  algo: Algo;
  serverSeed: string;
  clientSeed: string;
  nonce?: string;
  difficulty?: string;
  gridSize?: number;
  mineCount?: number;
  cardCount?: number;
  tag: string;
}
export interface Divergence {
  case: Case;
  step: string;
  values: Record<string, unknown>;
}
export interface ParityReport {
  pythonAvailable: boolean;
  pythonVersion: string | null;
  casesByAlgo: Record<string, number>;
  comparisons: number;
  divergences: Divergence[];
}

/* ------------------------------------------------------------------ deterministic inputs */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const MODES = ["CLASSIC", "LOW", "MEDIUM", "HIGH", "EXTREME"];
const GRIDS = [3, 5, 6, 7, 8];

/** Edge-case strings: non-ASCII (2/3/4-byte UTF-8, astral chars = UTF-16 surrogate pairs), colons, whitespace, HMAC key-size boundaries. */
export const EDGE_SEEDS: [string, string][] = [
  ["empty", ""],
  ["latin1", "héllo wörld"],
  ["cjk", "秘密の種"],
  ["emoji-astral", "\u{1F680}\u{1F3B2}seed\u{1F4B0}"],
  ["combining", "éé"],
  ["colons", "a:b:c::"],
  ["leading-trailing-space", "  padded  "],
  ["tab-newline", "tab\tnew\nline\r\n"],
  ["nul", "nul\u0000inside"],
  ["hex64", sha("hex64")],
  ["key-63-bytes", "k".repeat(63)],
  ["key-64-bytes", "k".repeat(64)],
  ["key-65-bytes", "k".repeat(65)],
  ["long-1000", "L".repeat(1000)],
  ["json-ish", '{"a":"b"}\\'],
];
export const EDGE_NONCES = ["0", "1", "9", "10", "4294967295", "4294967296", "9007199254740993", "18446744073709551615", "abc", " 1", "1 "];

export function buildCases(perAlgo = 300): Case[] {
  const cases: Case[] = [];
  const gen = (algo: Algo, i: number): Case => {
    // varied lengths so many different HMAC key/message sizes are covered
    const s = sha(`${algo}:s:${i}`).slice(0, 8 + (i % 57));
    const c = sha(`${algo}:c:${i}`).slice(0, 1 + (i % 33));
    const nonce = String(i * 7919);
    switch (algo) {
      case "crash":
        return { algo, serverSeed: s, clientSeed: c, tag: `gen-${i}` };
      case "blackjack":
        return { algo, serverSeed: s, clientSeed: c, cardCount: 1 + (i % 12), tag: `gen-${i}` };
      case "keno_v2":
      case "keno_v1":
        return { algo, serverSeed: s, clientSeed: c, nonce, difficulty: MODES[i % 5], tag: `gen-${i}` };
      default: {
        const g = GRIDS[i % 5];
        const m = 1 + ((i * 13) % (g * g - 1));
        return { algo, serverSeed: s, clientSeed: c, nonce, gridSize: g, mineCount: m, tag: `gen-${i}` };
      }
    }
  };
  const algos: Algo[] = ["crash", "blackjack", "keno_v2", "keno_v1", "mines_v2", "mines_v1"];
  for (const algo of algos) {
    for (let i = 0; i < perAlgo; i++) cases.push(gen(algo, i));
    // edge strings in both seed positions
    EDGE_SEEDS.forEach(([name, v], k) => {
      const base = gen(algo, 100000 + k);
      cases.push({ ...base, serverSeed: v, tag: `edge-server-${name}` });
      cases.push({ ...base, clientSeed: v, tag: `edge-client-${name}` });
    });
    if (algo.startsWith("keno") || algo.startsWith("mines")) {
      EDGE_NONCES.forEach((n, k) => cases.push({ ...gen(algo, 200000 + k), nonce: n, tag: `edge-nonce-${JSON.stringify(n)}` }));
    }
  }
  // every Keno mode and every Mines grid at min/max mine counts, both versions
  for (const v of ["v2", "v1"] as const) {
    for (const d of MODES) cases.push({ algo: `keno_${v}`, serverSeed: "mode-check", clientSeed: d, nonce: "1", difficulty: d, tag: `mode-${d}` });
    for (const g of GRIDS) {
      for (const m of [1, g * g - 1]) cases.push({ algo: `mines_${v}`, serverSeed: "grid-check", clientSeed: `${g}`, nonce: String(m), gridSize: g, mineCount: m, tag: `grid-${g}-${m}` });
    }
  }
  // Blackjack long sequence
  cases.push({ algo: "blackjack", serverSeed: "long-shoe", clientSeed: "c", cardCount: 416, tag: "416-cards" });
  return cases;
}

/* ------------------------------------------------------------------ implementations */
export type Steps = [string, unknown][];

export function prodSteps(c: Case): Steps {
  switch (c.algo) {
    case "crash": {
      const r = computeCrash(c.serverSeed, c.clientSeed, { trace: false });
      return [["digest", r.digest], ["instant", r.instantCrash], ["h", r.h], ["cents", Math.round(r.multiplier * 100)], ["multiplier", r.multiplier]];
    }
    case "blackjack": {
      const r = computeBlackjack(c.serverSeed, c.clientSeed, c.cardCount!, { trace: false });
      return r.cards.flatMap((k): Steps => [[`card${k.cardNumber}.hash`, k.hash], [`card${k.cardNumber}.h`, k.h], [`card${k.cardNumber}.card`, `${k.label}/${k.suit}`]]);
    }
    case "keno_v2":
    case "keno_v1": {
      const r = computeKeno(c.serverSeed, c.clientSeed, c.nonce!, c.algo === "keno_v2" ? "hmac_sha256_v2" : "seedrandom_v1", c.difficulty as never, { trace: false });
      return [["indices", r.indices], ["drawn", r.drawn]];
    }
    default: {
      const r = computeMines(c.serverSeed, c.clientSeed, c.nonce!, c.algo === "mines_v2" ? "hmac_sha256_v2" : "seedrandom_v1", c.gridSize as never, c.mineCount!, { trace: false });
      return [["indices", r.indices], ["mines", r.mines]];
    }
  }
}

/** The JS reference exposes only final results; intermediate steps are compared between prod and Python. */
function refjsFinal(c: Case): [string, unknown] {
  switch (c.algo) {
    case "crash":
      return ["multiplier", ref.verifyCrash(c.serverSeed, c.clientSeed)];
    case "blackjack":
      return ["cards", Array.from({ length: c.cardCount! }, (_, i) => ref.generateCard(c.serverSeed, c.clientSeed, i + 1)).map((k) => `${k.label}/${k.suit}`)];
    case "keno_v2":
    case "keno_v1":
      return ["drawn", ref.kenoDraw(c.serverSeed, c.clientSeed, c.nonce!, c.algo === "keno_v2" ? "hmac_sha256_v2" : "seedrandom_v1", c.difficulty!)];
    default:
      return ["mines", ref.minesPlacement(c.serverSeed, c.clientSeed, c.nonce!, c.algo === "mines_v2" ? "hmac_sha256_v2" : "seedrandom_v1", c.gridSize!, c.mineCount!)];
  }
}

function prodFinal(c: Case, steps: Steps): [string, unknown] {
  const get = (k: string) => steps.find((s) => s[0] === k)?.[1];
  if (c.algo === "crash") return ["multiplier", get("multiplier")];
  if (c.algo === "blackjack") return ["cards", steps.filter((s) => s[0].endsWith(".card")).map((s) => s[1])];
  if (c.algo.startsWith("keno")) return ["drawn", get("drawn")];
  return ["mines", get("mines")];
}

function pyToSteps(c: Case, r: Record<string, any>): Steps {
  switch (c.algo) {
    case "crash":
      // multiplier = cents/100 computed in JS exactly as the production formula divides
      return [["digest", r.digest], ["instant", r.instant], ["h", r.h], ["cents", r.cents], ["multiplier", r.cents / 100]];
    case "blackjack":
      return (r.cards as any[]).flatMap((k, i): Steps => [[`card${i + 1}.hash`, k.hash], [`card${i + 1}.h`, k.h], [`card${i + 1}.card`, `${k.label}/${k.suit}`]]);
    case "keno_v2":
    case "keno_v1":
      return [["indices", r.indices], ["drawn", r.drawn]];
    default:
      return [["indices", r.indices], ["mines", r.mines]];
  }
}

function findPython(): { cmd: string; version: string } | null {
  for (const cmd of [process.env.PYTHON, "python", "python3", "py"].filter(Boolean) as string[]) {
    const r = spawnSync(cmd, ["-I", "-c", "import sys;print(sys.version.split()[0])"], { encoding: "utf8", timeout: 15000 });
    if (r.status === 0 && /^3\.\d+/.test(r.stdout.trim())) return { cmd, version: r.stdout.trim() };
  }
  return null;
}

function runPython(cmd: string, cases: Case[]): Record<string, any>[] {
  const payload = cases.map((c) => ({
    algo: c.algo.split("_")[0],
    serverSeed: c.serverSeed,
    clientSeed: c.clientSeed,
    nonce: c.nonce,
    version: c.algo.endsWith("_v1") ? "seedrandom_v1" : "hmac_sha256_v2",
    difficulty: c.difficulty,
    gridSize: c.gridSize,
    mineCount: c.mineCount,
    cardCount: c.cardCount,
  }));
  const script = fileURLToPath(new URL("./reference/independent.py", import.meta.url));
  const r = spawnSync(cmd, ["-I", script], { input: JSON.stringify({ cases: payload }), maxBuffer: 512 * 1024 * 1024, timeout: 300000 });
  if (r.status !== 0) throw new Error(`python implementation failed: ${r.stderr?.toString()}`);
  return JSON.parse(r.stdout.toString("utf8")).results;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface ParityOptions {
  /** substitute implementation under test (used by mutation tests to prove the harness detects bugs) */
  prod?: (c: Case) => Steps;
  /** skip the Python implementation */
  noPython?: boolean;
}

export function runParity(cases = buildCases(), opts: ParityOptions = {}): ParityReport {
  const impl = opts.prod ?? prodSteps;
  const py = opts.noPython ? null : findPython();
  const pyResults = py ? runPython(py.cmd, cases) : null;
  const divergences: Divergence[] = [];
  const casesByAlgo: Record<string, number> = {};
  let comparisons = 0;

  cases.forEach((c, i) => {
    casesByAlgo[c.algo] = (casesByAlgo[c.algo] ?? 0) + 1;
    const prod = impl(c);
    // 1. production vs unchanged JS reference (final result)
    const [fk, fv] = prodFinal(c, prod);
    const [, rv] = refjsFinal(c);
    comparisons++;
    if (!same(fv, rv)) divergences.push({ case: c, step: `final:${fk}`, values: { prod: fv, refjs: rv } });
    // 2. production vs independent Python, step by step
    if (pyResults) {
      const pySteps = pyToSteps(c, pyResults[i]);
      for (let k = 0; k < Math.max(prod.length, pySteps.length); k++) {
        comparisons++;
        const [name, pv] = prod[k] ?? ["<missing>", undefined];
        const [, yv] = pySteps[k] ?? ["<missing>", undefined];
        if (!same(pv, yv)) {
          divergences.push({ case: c, step: name, values: { prod: pv, python: yv } });
          break; // first divergence only
        }
      }
    }
  });

  return { pythonAvailable: !!py, pythonVersion: py?.version ?? null, casesByAlgo, comparisons, divergences };
}
