import { checkCommitment, type CommitmentResult, type CommitmentScheme } from "../crypto/commitments.js";
import { computeCrash } from "../games/crash.js";
import { computeBlackjack, AVAILABLE_LABELS, AVAILABLE_SUITS } from "../games/blackjack.js";
import { computeKeno, BOARD_BY_MODE, KENO_MAX_PICKS, KENO_MIN_PICKS, type KenoDifficulty } from "../games/keno.js";
import { computeMines, MINES_GRID_SIZES, type MinesGridSize } from "../games/mines.js";
import {
  ALGORITHM_VERSIONS,
  BLACKJACK_VERSION,
  CRASH_VERSION,
  type AlgorithmVersion,
  type Game,
  type TraceStep,
} from "../types.js";
import { roundInputSchema, type RoundInput } from "./schemas.js";

export const APP_VERSION = "1.0.0";

export type OutcomeStatus =
  | "reconstructed"
  | "match"
  | "mismatch"
  | "missing_comparison"
  | "invalid_input"
  | "unsupported_version";
export type TimingStatus = "pre_round_publication_verified" | "publication_timing_unverified";
export type OverallStatus =
  | "verified_sufficient_evidence"
  | "match_commitment_unproven"
  | "reconstructed_only"
  | "mismatch"
  | "incomplete"
  | "unsupported";

export interface VerificationResult {
  game: Game | string;
  roundId: string | null;
  algorithmVersion: string | null;
  inputs: unknown;
  calculated: Record<string, unknown> | null;
  reported: Record<string, unknown> | null;
  outcome: { status: OutcomeStatus; details: string[] };
  commitment: CommitmentResult | { status: "not_supplied"; note: string };
  timing: { status: TimingStatus; note: string };
  payout: { status: "unavailable"; note: string } | null;
  overall: OverallStatus;
  errors: { field: string; message: string }[];
  trace: TraceStep[];
  computedAt: string;
  appVersion: string;
}

export interface VerifyOptions {
  commitmentScheme: CommitmentScheme;
  /** "manual": no reported value means a pure reconstruction. "import": the record claims to be historical, so absence is a gap. */
  mode: "manual" | "import";
}

const TIMING_NOTE =
  "No independently timestamped evidence (e.g. a confirmed on-chain commitment publication) shows the commitment existed before the round. A hash typed or imported by the user does not establish timing.";

function overallFrom(outcome: OutcomeStatus, commitment: string, timing: TimingStatus): OverallStatus {
  if (outcome === "unsupported_version") return "unsupported";
  if (outcome === "invalid_input") return "incomplete";
  if (outcome === "mismatch" || commitment === "mismatch") return "mismatch";
  if (outcome === "match") {
    return commitment === "verified" && timing === "pre_round_publication_verified"
      ? "verified_sufficient_evidence"
      : "match_commitment_unproven";
  }
  return "reconstructed_only";
}

function base(input: Partial<RoundInput> & { game?: string }, opts: VerifyOptions): VerificationResult {
  return {
    game: input.game ?? "unknown",
    roundId: (input.roundId as string | null | undefined) ?? null,
    algorithmVersion: null,
    inputs: input,
    calculated: null,
    reported: null,
    outcome: { status: "invalid_input", details: [] },
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

function noComparison(opts: VerifyOptions): OutcomeStatus {
  return opts.mode === "import" ? "missing_comparison" : "reconstructed";
}

const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));

export function verifyRound(raw: unknown, opts: VerifyOptions): VerificationResult {
  const parsed = roundInputSchema.safeParse(raw);
  if (!parsed.success) {
    const r = base((raw ?? {}) as Partial<RoundInput>, opts);
    r.errors = parsed.error.issues.map((i) => ({ field: i.path.join(".") || "input", message: i.message }));
    r.outcome = { status: "invalid_input", details: r.errors.map((e) => `${e.field}: ${e.message}`) };
    return finish(r);
  }
  const input = parsed.data;
  const r = base(input, opts);
  r.inputs = input;
  try {
    switch (input.game) {
      case "crash":
        verifyCrash(input, r, opts);
        break;
      case "blackjack":
        verifyBlackjack(input, r, opts);
        break;
      case "keno":
        verifyKeno(input, r, opts);
        break;
      case "mines":
        verifyMines(input, r, opts);
        break;
    }
  } catch (err) {
    r.errors.push({ field: "input", message: (err as Error).message });
    r.outcome = { status: "invalid_input", details: [(err as Error).message] };
    return finish(r);
  }
  if (r.outcome.status !== "invalid_input" && r.outcome.status !== "unsupported_version") {
    r.commitment = checkCommitment(input.serverSeed, input.commitment, opts.commitmentScheme);
  }
  return finish(r);
}

function verifyCrash(input: Extract<RoundInput, { game: "crash" }>, r: VerificationResult, opts: VerifyOptions) {
  r.algorithmVersion = CRASH_VERSION;
  const c = computeCrash(input.serverSeed, input.clientSeed);
  r.trace = c.trace.steps;
  r.calculated = {
    multiplier: c.multiplier,
    multiplierText: c.multiplier.toFixed(2),
    digest: c.digest,
    mod20: c.mod20,
    instantCrash: c.instantCrash,
    h: c.h,
    e: c.e,
  };
  const rep = input.reported?.multiplier;
  if (rep === undefined || rep === null) {
    r.outcome = { status: noComparison(opts), details: ["No reported multiplier supplied."] };
    return;
  }
  r.reported = { multiplier: rep };
  // Reported multipliers are displayed to 2 decimals by the game; compare at that precision.
  const match = rep.toFixed(2) === c.multiplier.toFixed(2);
  r.outcome = {
    status: match ? "match" : "mismatch",
    details: [`Calculated ${c.multiplier.toFixed(2)}x vs reported ${rep.toFixed(2)}x`],
  };
}

function verifyBlackjack(input: Extract<RoundInput, { game: "blackjack" }>, r: VerificationResult, opts: VerifyOptions) {
  r.algorithmVersion = BLACKJACK_VERSION;
  const reported = input.reported?.cards ?? null;
  const count = Math.max(input.cardCount, reported?.length ?? 0);
  const { cards, trace } = computeBlackjack(input.serverSeed, input.clientSeed, count);
  r.trace = trace.steps;
  r.calculated = { cards, cardCount: count };
  if (!reported || reported.length === 0) {
    r.outcome = { status: noComparison(opts), details: ["No reported cards supplied — card sequence reconstructed only."] };
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
  reported.forEach((c, i) => {
    const g = cards[i];
    if (g.label !== c.label || g.suit !== c.suit) diffs.push(`Card ${i + 1}: calculated ${g.label} of ${g.suit}, reported ${c.label} of ${c.suit}`);
  });
  r.outcome = {
    status: diffs.length ? "mismatch" : "match",
    details: diffs.length ? diffs : [`All ${reported.length} reported cards match card numbers 1-${reported.length}.`],
  };
}

function checkVersion(v: string, r: VerificationResult): v is AlgorithmVersion {
  if ((ALGORITHM_VERSIONS as string[]).includes(v)) return true;
  r.algorithmVersion = v;
  r.outcome = { status: "unsupported_version", details: [`Unsupported algorithm version "${v}". Supported: ${ALGORITHM_VERSIONS.join(", ")}`] };
  return false;
}

function verifyKeno(input: Extract<RoundInput, { game: "keno" }>, r: VerificationResult, opts: VerifyOptions) {
  if (!checkVersion(input.algorithmVersion, r)) return;
  r.algorithmVersion = input.algorithmVersion;
  const difficulty = input.difficulty as KenoDifficulty;
  const { tileCount } = BOARD_BY_MODE[difficulty];

  const picks = input.selectedNumbers ?? [];
  const pickErrors: string[] = [];
  if (picks.length > 0) {
    if (picks.length < KENO_MIN_PICKS || picks.length > KENO_MAX_PICKS) pickErrors.push(`Select ${KENO_MIN_PICKS}-${KENO_MAX_PICKS} numbers (got ${picks.length})`);
    if (new Set(picks).size !== picks.length) pickErrors.push("Selected numbers must be unique");
    const out = picks.filter((n) => n < 1 || n > tileCount);
    if (out.length) pickErrors.push(`Selected numbers outside 1-${tileCount}: ${out.join(", ")}`);
  }
  if (pickErrors.length) {
    r.errors.push(...pickErrors.map((m) => ({ field: "selectedNumbers", message: m })));
    r.outcome = { status: "invalid_input", details: pickErrors };
    return;
  }

  const k = computeKeno(input.serverSeed, input.clientSeed, input.nonce, input.algorithmVersion, difficulty);
  r.trace = k.trace.steps;
  const matched = k.drawn.filter((n) => picks.includes(n));
  r.calculated = {
    difficulty,
    tileCount: k.tileCount,
    drawn: k.drawn,
    drawnSorted: [...k.drawn].sort((a, b) => a - b),
    selectedNumbers: picks,
    matched,
    matchCount: matched.length,
    pickCount: picks.length,
  };
  r.payout = {
    status: "unavailable",
    note: "Authentic Solpump Keno payout tables have not been independently established; only the draw and match count are verified.",
  };

  const rep = input.reported?.draw;
  if (!rep || rep.length === 0) {
    r.outcome = { status: noComparison(opts), details: ["No reported draw supplied — winning numbers reconstructed only."] };
    return;
  }
  const repErrors: string[] = [];
  if (rep.length !== 10) repErrors.push(`Reported draw has ${rep.length} numbers; Solpump Keno draws exactly 10`);
  if (new Set(rep).size !== rep.length) repErrors.push("Reported draw contains duplicates");
  const outside = rep.filter((n) => n < 1 || n > tileCount);
  if (outside.length) repErrors.push(`Reported numbers outside 1-${tileCount}: ${outside.join(", ")}`);
  r.reported = { draw: rep };
  if (repErrors.length) {
    r.outcome = { status: "mismatch", details: repErrors };
    return;
  }
  const setMatch = sameSet(rep, k.drawn);
  const orderMatch = setMatch && rep.every((n, i) => n === k.drawn[i]);
  const details = setMatch
    ? [orderMatch ? "Reported draw matches the calculated draw in generation order." : "Reported numbers match the calculated set (reported order differs from generation order)."]
    : [
        `Missing from reported: ${k.drawn.filter((n) => !rep.includes(n)).join(", ") || "none"}`,
        `Unexpected in reported: ${rep.filter((n) => !k.drawn.includes(n)).join(", ") || "none"}`,
      ];
  (r.calculated as Record<string, unknown>).orderMatches = orderMatch;
  r.outcome = { status: setMatch ? "match" : "mismatch", details };
}

function verifyMines(input: Extract<RoundInput, { game: "mines" }>, r: VerificationResult, opts: VerifyOptions) {
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
  const toZero = (list: number[] | null | undefined) => (list ?? []).map((n) => n - shift);
  const clicked = toZero(input.clickedTiles);
  const rep = input.reported?.mines ? toZero(input.reported.mines) : null;

  const bounds = (list: number[], field: string) => {
    const bad = list.filter((n) => n < 0 || n >= tileCount);
    if (bad.length) r.errors.push({ field, message: `Tiles outside the ${tileCount}-tile board: ${bad.map((n) => n + shift).join(", ")}` });
  };
  bounds(clicked, "clickedTiles");
  if (rep) bounds(rep, "reported.mines");
  if (r.errors.length) {
    r.outcome = { status: "invalid_input", details: r.errors.map((e) => e.message) };
    return;
  }

  const m = computeMines(input.serverSeed, input.clientSeed, input.nonce, input.algorithmVersion, gridSize, input.mineCount);
  r.trace = m.trace.steps;
  const hits = clicked.filter((t) => m.mines.includes(t));
  const derivedOutcome = clicked.length ? (hits.length ? "loss" : "win") : null;
  r.calculated = {
    gridSize,
    tileCount,
    mineCount: input.mineCount,
    mines: m.mines,
    minesSorted: m.minesSorted,
    safe: m.safe,
    clickedTiles: clicked,
    clickedMines: hits,
    derivedOutcome,
  };

  const details: string[] = [];
  let status: OutcomeStatus = noComparison(opts);
  let compared = false;
  let mismatch = false;
  if (rep && rep.length) {
    compared = true;
    r.reported = { ...(r.reported ?? {}), mines: rep };
    if (sameSet(rep, m.mines)) details.push("Reported mine positions match the calculated positions.");
    else {
      mismatch = true;
      details.push(
        `Calculated mines not reported: ${m.mines.filter((t) => !rep.includes(t)).join(", ") || "none"} (0-based)`,
        `Reported mines not calculated: ${rep.filter((t) => !m.mines.includes(t)).join(", ") || "none"} (0-based)`,
      );
    }
  }
  const repOutcome = input.reported?.outcome ?? null;
  if (repOutcome) {
    r.reported = { ...(r.reported ?? {}), outcome: repOutcome };
    if (derivedOutcome) {
      compared = true;
      if (derivedOutcome === repOutcome) details.push(`Reported outcome "${repOutcome}" is consistent with the clicked tiles.`);
      else {
        mismatch = true;
        details.push(`Reported outcome "${repOutcome}" but clicked tiles imply "${derivedOutcome}" (mine hits: ${hits.join(", ") || "none"}).`);
      }
    } else details.push("Reported outcome supplied without clicked tiles — cannot be compared.");
  }
  if (compared) status = mismatch ? "mismatch" : "match";
  else details.push("No reported mine positions supplied — board reconstructed only.");
  r.outcome = { status, details };
}
