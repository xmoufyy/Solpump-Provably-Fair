import { checkCommitment } from "../crypto/commitments.js";
import { computeCrash } from "../games/crash.js";
import { AVAILABLE_LABELS, AVAILABLE_SUITS, computeBlackjack } from "../games/blackjack.js";
import { computeKeno } from "../games/keno.js";
import { computeMines } from "../games/mines.js";
import {
  ALGORITHM_VERSIONS,
  BLACKJACK_VERSION,
  CRASH_VERSION,
  KENO_BOARD,
  KENO_MAX_PICKS,
  KENO_MIN_PICKS,
  MINES_GRID_SIZES,
  type AlgorithmVersion,
  type CommitmentScheme,
  type CommitmentStatus,
  type ComparisonRow,
  type KenoDifficulty,
  type MinesGridSize,
  type OutcomeStatus,
  type OverallStatus,
  type TimingStatus,
  type VerificationResult,
} from "../../../shared/src/contracts.js";
import { roundInputSchema, type RoundInput } from "./schemas.js";

export type { OutcomeStatus, OverallStatus, TimingStatus, VerificationResult } from "../../../shared/src/contracts.js";
export const APP_VERSION = "2.0.0";

export interface VerifyOptions {
  commitmentScheme: CommitmentScheme;
  /** "manual": no reported value means a pure reconstruction. "import": the record claims to be historical, so absence is a gap. */
  mode: "manual" | "import";
  /** build the human-readable trace (default true). Batch imports disable it; it is regenerated on demand. */
  trace?: boolean;
}

const TIMING_NOTE =
  "No independently timestamped evidence (e.g. a confirmed on-chain commitment publication linked to this round) shows the commitment existed before the round. A hash typed or imported by the user does not establish timing.";

/** The single place that turns the separate evidence statuses into a final assessment. */
export function overallFrom(outcome: OutcomeStatus, commitment: CommitmentStatus | "not_supplied", timing: TimingStatus): OverallStatus {
  if (outcome === "unsupported_version") return "unsupported";
  if (outcome === "invalid_input") return "incomplete";
  if (outcome === "mismatch") return "mismatch";
  if (commitment === "mismatch") return "commitment_mismatch";
  if (outcome === "match") {
    return commitment === "verified" && timing === "pre_round_publication_verified" ? "verified_sufficient_evidence" : "match_commitment_unproven";
  }
  return "reconstructed_only";
}

function base(input: Record<string, unknown>): VerificationResult {
  return {
    game: typeof input.game === "string" ? input.game : "unknown",
    roundId: typeof input.roundId === "string" ? input.roundId : null,
    algorithmVersion: null,
    inputs: input,
    calculated: null,
    reported: null,
    outcome: { status: "invalid_input", details: [] },
    comparisons: [],
    commitment: { status: "not_supplied", note: "No commitment supplied." },
    timing: { status: "publication_timing_unverified", note: TIMING_NOTE },
    payout: null,
    overall: "incomplete",
    errors: [],
    trace: [],
    computedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
  };
}

function finish(r: VerificationResult): VerificationResult {
  r.overall = overallFrom(r.outcome.status, r.commitment.status, r.timing.status);
  return r;
}

const noComparison = (opts: VerifyOptions): OutcomeStatus => (opts.mode === "import" ? "missing_comparison" : "reconstructed");

/** Multiset equality: [0,0,14] is NOT equal to [0,14,22] (v1 bug F-02). */
export function sameMultiset(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
}
const hasDuplicates = (a: readonly number[]) => new Set(a).size !== a.length;
const list = (a: readonly number[] | null | undefined) => (a && a.length ? a.join(", ") : null);

export function verifyRound(raw: unknown, opts: VerifyOptions): VerificationResult {
  const rawObj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const parsed = roundInputSchema.safeParse(raw);
  if (!parsed.success) {
    const r = base(rawObj);
    r.errors = parsed.error.issues.map((i) => ({ field: i.path.join(".") || "input", message: i.message }));
    r.outcome = { status: "invalid_input", details: r.errors.map((e) => `${e.field}: ${e.message}`) };
    return finish(r);
  }
  const input = parsed.data;
  const r = base(input as Record<string, unknown>);
  const trace = opts.trace ?? true;
  try {
    switch (input.game) {
      case "crash":
        verifyCrash(input, r, opts, trace);
        break;
      case "blackjack":
        verifyBlackjack(input, r, opts, trace);
        break;
      case "keno":
        verifyKeno(input, r, opts, trace);
        break;
      case "mines":
        verifyMines(input, r, opts, trace);
        break;
    }
  } catch (err) {
    r.errors.push({ field: "input", message: (err as Error).message });
    r.outcome = { status: "invalid_input", details: [(err as Error).message] };
    return finish(r);
  }
  if (r.outcome.status !== "invalid_input" && r.outcome.status !== "unsupported_version") {
    const c = checkCommitment(input.serverSeed, input.commitment, opts.commitmentScheme);
    r.commitment = c;
    if (c.status !== "not_supplied") {
      r.comparisons.push({
        field: "Commitment (server seed hash)",
        reported: c.supplied,
        reconstructed: c.candidateSha256,
        status: c.status === "verified" ? "match" : c.status === "mismatch" ? "mismatch" : "info",
        note:
          c.status === "scheme_unconfirmed"
            ? `Candidate SHA-256(serverSeed) ${c.candidateMatches ? "equals" : "differs from"} the supplied value; scheme not confirmed, so this is not verification.`
            : undefined,
      });
    }
  }
  return finish(r);
}

function algorithmRow(recorded: string | null, applied: string): ComparisonRow {
  return { field: "Algorithm version", reported: recorded, reconstructed: applied, status: "info", note: recorded ? "Taken from the record; never inferred from which version matches." : "Single published algorithm." };
}

function verifyCrash(input: Extract<RoundInput, { game: "crash" }>, r: VerificationResult, opts: VerifyOptions, trace: boolean) {
  r.algorithmVersion = CRASH_VERSION;
  const c = computeCrash(input.serverSeed, input.clientSeed, { trace });
  r.trace = c.trace.steps;
  r.calculated = { multiplier: c.multiplier, multiplierText: c.multiplier.toFixed(2), digest: c.digest, mod20: c.mod20, instantCrash: c.instantCrash, h: c.h, e: c.e };
  r.comparisons.push(algorithmRow(null, CRASH_VERSION));
  const rep = input.reported?.multiplier;
  if (rep === undefined || rep === null) {
    r.outcome = { status: noComparison(opts), details: ["No reported multiplier supplied."] };
    r.comparisons.unshift({ field: "Crash multiplier", reported: null, reconstructed: `${c.multiplier.toFixed(2)}x`, status: "not_compared" });
    return;
  }
  r.reported = { multiplier: rep };
  // The algorithm yields exactly k/100. A reported value parsed from "1.25" is the same double as 125/100,
  // so strict equality is exact; 1.254 or 1.249 must NOT be rounded into a match (v1 bug F-01).
  const match = rep === c.multiplier;
  r.comparisons.unshift({
    field: "Crash multiplier",
    reported: `${rep}x`,
    reconstructed: `${c.multiplier.toFixed(2)}x`,
    status: match ? "match" : "mismatch",
    note: !match && Math.round(rep * 100) / 100 !== rep ? "Reported value has more than 2 decimals; the algorithm only produces whole hundredths." : undefined,
  });
  r.outcome = { status: match ? "match" : "mismatch", details: [`Calculated ${c.multiplier.toFixed(2)}x vs reported ${rep}x`] };
}

function verifyBlackjack(input: Extract<RoundInput, { game: "blackjack" }>, r: VerificationResult, opts: VerifyOptions, trace: boolean) {
  r.algorithmVersion = BLACKJACK_VERSION;
  const reported = input.reported?.cards ?? null;
  const count = Math.max(input.cardCount, reported?.length ?? 0);
  const { cards, trace: t } = computeBlackjack(input.serverSeed, input.clientSeed, count, { trace });
  r.trace = t.steps;
  r.calculated = { cards, cardCount: count };
  r.comparisons.push(algorithmRow(null, BLACKJACK_VERSION));
  if (!reported || reported.length === 0) {
    r.outcome = { status: noComparison(opts), details: ["No reported cards supplied - card sequence reconstructed only. Player/dealer assignment is not part of the published algorithm."] };
    r.comparisons.unshift({ field: `Cards 1-${count}`, reported: null, reconstructed: cards.map((k) => `${k.label} ${k.suit}`).join(", "), status: "not_compared" });
    return;
  }
  const bad = reported.findIndex(
    (c) => !(AVAILABLE_LABELS as readonly string[]).includes(c.label) || !(AVAILABLE_SUITS as readonly string[]).includes(c.suit),
  );
  if (bad >= 0) {
    r.errors.push({ field: `reported.cards.${bad}`, message: "Unknown card label or suit" });
    r.outcome = { status: "invalid_input", details: [`Reported card #${bad + 1} is not a valid card`] };
    return;
  }
  r.reported = { cards: reported };
  const diffs: string[] = [];
  const rows: ComparisonRow[] = reported.map((c, i) => {
    const g = cards[i];
    const ok = g.label === c.label && g.suit === c.suit;
    if (!ok) diffs.push(`Card ${i + 1}: calculated ${g.label} of ${g.suit}, reported ${c.label} of ${c.suit}`);
    return { field: `Card ${i + 1}`, reported: `${c.label} ${c.suit}`, reconstructed: `${g.label} ${g.suit}`, status: ok ? "match" : "mismatch" };
  });
  r.comparisons.unshift(...rows);
  r.outcome = {
    status: diffs.length ? "mismatch" : "match",
    details: diffs.length ? diffs : [`All ${reported.length} reported cards match card numbers 1-${reported.length}.`],
  };
}

function checkVersion(v: string, r: VerificationResult): v is AlgorithmVersion {
  if ((ALGORITHM_VERSIONS as readonly string[]).includes(v)) return true;
  r.algorithmVersion = v;
  r.outcome = { status: "unsupported_version", details: [`Unsupported algorithm version "${v}". Supported: ${ALGORITHM_VERSIONS.join(", ")}`] };
  return false;
}

function verifyKeno(input: Extract<RoundInput, { game: "keno" }>, r: VerificationResult, opts: VerifyOptions, trace: boolean) {
  if (!checkVersion(input.algorithmVersion, r)) return;
  r.algorithmVersion = input.algorithmVersion;
  const difficulty = input.difficulty as KenoDifficulty;
  const { tileCount } = KENO_BOARD[difficulty];

  const picks = input.selectedNumbers ?? [];
  const pickErrors: string[] = [];
  if (picks.length > 0) {
    if (picks.length < KENO_MIN_PICKS || picks.length > KENO_MAX_PICKS) pickErrors.push(`Select ${KENO_MIN_PICKS}-${KENO_MAX_PICKS} numbers (got ${picks.length})`);
    if (hasDuplicates(picks)) pickErrors.push("Selected numbers must be unique");
    const out = picks.filter((n) => n < 1 || n > tileCount);
    if (out.length) pickErrors.push(`Selected numbers outside 1-${tileCount}: ${out.join(", ")}`);
  }
  if (pickErrors.length) {
    r.errors.push(...pickErrors.map((m) => ({ field: "selectedNumbers", message: m })));
    r.outcome = { status: "invalid_input", details: pickErrors };
    return;
  }

  const k = computeKeno(input.serverSeed, input.clientSeed, input.nonce, input.algorithmVersion, difficulty, { trace });
  r.trace = k.trace.steps;
  const matched = k.drawn.filter((n) => picks.includes(n));
  r.calculated = {
    difficulty,
    tileCount: k.tileCount,
    drawn: k.drawn,
    drawnSorted: [...k.drawn].sort((a, b) => a - b),
    indices: k.indices,
    selectedNumbers: picks,
    matched,
    matchCount: matched.length,
    pickCount: picks.length,
  };
  r.payout = {
    status: "unavailable",
    note: "Authentic Solpump Keno payout tables have not been independently established; only the draw and match count are verified.",
  };
  const algo = algorithmRow(input.algorithmVersion, input.algorithmVersion);
  const pickRow: ComparisonRow = { field: "Matches with your picks", reported: picks.length ? `${picks.length} picks` : null, reconstructed: `${matched.length} (${list(matched) ?? "none"})`, status: "info", note: "Picks never influence the draw." };

  const rep = input.reported?.draw;
  if (!rep || rep.length === 0) {
    r.outcome = { status: noComparison(opts), details: ["No reported draw supplied - winning numbers reconstructed only."] };
    r.comparisons.push({ field: "Winning numbers", reported: null, reconstructed: list(k.drawn), status: "not_compared" }, pickRow, algo);
    return;
  }
  const repErrors: string[] = [];
  if (rep.length !== 10) repErrors.push(`Reported draw has ${rep.length} numbers; Solpump Keno draws exactly 10`);
  if (hasDuplicates(rep)) repErrors.push("Reported draw contains duplicates");
  const outside = rep.filter((n) => n < 1 || n > tileCount);
  if (outside.length) repErrors.push(`Reported numbers outside 1-${tileCount}: ${outside.join(", ")}`);
  r.reported = { draw: rep };
  const setMatch = repErrors.length === 0 && sameMultiset(rep, k.drawn);
  const orderMatch = setMatch && rep.every((n, i) => n === k.drawn[i]);
  r.calculated.orderMatches = orderMatch;
  r.comparisons.push(
    { field: "Winning numbers (as a set)", reported: list(rep), reconstructed: list(k.drawn), status: setMatch ? "match" : "mismatch", note: repErrors.join("; ") || undefined },
    { field: "Draw order", reported: list(rep), reconstructed: list(k.drawn), status: "info", note: orderMatch ? "Same order as generated." : "Order differs (many interfaces display draws sorted)." },
    pickRow,
    algo,
  );
  if (repErrors.length) {
    r.outcome = { status: "mismatch", details: repErrors };
    return;
  }
  r.outcome = {
    status: setMatch ? "match" : "mismatch",
    details: setMatch
      ? [orderMatch ? "Reported draw matches the calculated draw in generation order." : "Reported numbers match the calculated set (reported order differs from generation order)."]
      : [
          `Missing from reported: ${k.drawn.filter((n) => !rep.includes(n)).join(", ") || "none"}`,
          `Unexpected in reported: ${rep.filter((n) => !k.drawn.includes(n)).join(", ") || "none"}`,
        ],
  };
}

function verifyMines(input: Extract<RoundInput, { game: "mines" }>, r: VerificationResult, opts: VerifyOptions, trace: boolean) {
  if (!checkVersion(input.algorithmVersion, r)) return;
  r.algorithmVersion = input.algorithmVersion;
  if (!(MINES_GRID_SIZES as readonly number[]).includes(input.gridSize)) {
    r.errors.push({ field: "gridSize", message: "Grid must be 3, 5, 6, 7 or 8 (9/25/36/49/64 tiles)" });
    r.outcome = { status: "invalid_input", details: ["Unsupported grid size"] };
    return;
  }
  const gridSize = input.gridSize as MinesGridSize;
  const tileCount = gridSize * gridSize;
  if (input.mineCount < 1 || input.mineCount > tileCount - 1) {
    r.errors.push({ field: "mineCount", message: `Mine count must be 1-${tileCount - 1}` });
    r.outcome = { status: "invalid_input", details: [`Mine count must be 1-${tileCount - 1} on ${tileCount} tiles`] };
    return;
  }
  const shift = input.indexBase;
  const toZero = (l: number[] | null | undefined) => (l ?? []).map((n) => n - shift);
  const clicked = toZero(input.clickedTiles);
  const rep = input.reported?.mines ? toZero(input.reported.mines) : null;

  const bounds = (l: number[], field: string) => {
    const bad = l.filter((n) => n < 0 || n >= tileCount);
    if (bad.length) r.errors.push({ field, message: `Tiles outside the ${tileCount}-tile board (${shift}-based): ${bad.map((n) => n + shift).join(", ")}` });
  };
  bounds(clicked, "clickedTiles");
  if (rep) bounds(rep, "reported.mines");
  if (r.errors.length) {
    r.outcome = { status: "invalid_input", details: r.errors.map((e) => e.message) };
    return;
  }

  const m = computeMines(input.serverSeed, input.clientSeed, input.nonce, input.algorithmVersion, gridSize, input.mineCount, { trace });
  r.trace = m.trace.steps;
  const hits = clicked.filter((t) => m.mines.includes(t));
  const derivedOutcome = clicked.length ? (hits.length ? "loss" : "win") : null;
  r.calculated = {
    gridSize,
    tileCount,
    mineCount: input.mineCount,
    mines: m.mines,
    minesSorted: m.minesSorted,
    indices: m.indices,
    safe: m.safe,
    clickedTiles: clicked,
    clickedMines: hits,
    derivedOutcome,
  };

  const details: string[] = [];
  let compared = false;
  let mismatch = false;
  if (rep && rep.length) {
    compared = true;
    r.reported = { ...(r.reported ?? {}), mines: rep };
    const notes: string[] = [];
    if (hasDuplicates(rep)) notes.push("Reported positions contain duplicates");
    if (rep.length !== input.mineCount) notes.push(`${rep.length} positions reported for ${input.mineCount} mines`);
    const ok = notes.length === 0 && sameMultiset(rep, m.mines);
    r.comparisons.push({
      field: "Mine positions (0-based, as a set)",
      reported: list([...rep].sort((a, b) => a - b)),
      reconstructed: list(m.minesSorted),
      status: ok ? "match" : "mismatch",
      note: notes.join("; ") || (shift ? "Reported 1-based tiles converted to 0-based." : undefined),
    });
    if (ok) details.push("Reported mine positions match the calculated positions.");
    else {
      mismatch = true;
      details.push(
        ...notes,
        `Calculated mines not reported: ${m.mines.filter((t) => !rep.includes(t)).join(", ") || "none"} (0-based)`,
        `Reported mines not calculated: ${[...new Set(rep)].filter((t) => !m.mines.includes(t)).join(", ") || "none"} (0-based)`,
      );
    }
  } else {
    r.comparisons.push({ field: "Mine positions (0-based)", reported: null, reconstructed: list(m.minesSorted), status: "not_compared" });
  }
  const repOutcome = input.reported?.outcome ?? null;
  if (repOutcome) {
    r.reported = { ...(r.reported ?? {}), outcome: repOutcome };
    if (derivedOutcome) {
      compared = true;
      const ok = derivedOutcome === repOutcome;
      r.comparisons.push({ field: "Round outcome", reported: repOutcome, reconstructed: `${derivedOutcome}${hits.length ? ` (mine at ${hits.join(", ")})` : ""}`, status: ok ? "match" : "mismatch" });
      if (ok) details.push(`Reported outcome "${repOutcome}" is consistent with the clicked tiles.`);
      else {
        mismatch = true;
        details.push(`Reported outcome "${repOutcome}" but clicked tiles imply "${derivedOutcome}" (mine hits: ${hits.join(", ") || "none"}).`);
      }
    } else {
      r.comparisons.push({ field: "Round outcome", reported: repOutcome, reconstructed: null, status: "not_compared", note: "Clicked tiles are needed to derive the outcome." });
      details.push("Reported outcome supplied without clicked tiles - cannot be compared.");
    }
  }
  r.comparisons.push(algorithmRow(input.algorithmVersion, input.algorithmVersion));
  if (!compared) details.push("No reported mine positions supplied - board reconstructed only.");
  r.outcome = { status: compared ? (mismatch ? "mismatch" : "match") : noComparison(opts), details };
}
