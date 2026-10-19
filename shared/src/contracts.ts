/**
 * API contracts shared by the backend (producer) and the frontend (consumer).
 * Keeping these in one place removes the duplicated, drifting copies v1 had.
 */

export type Game = "crash" | "blackjack" | "keno" | "mines";
export const GAMES: readonly Game[] = ["crash", "blackjack", "keno", "mines"];

export type AlgorithmVersion = "hmac_sha256_v2" | "seedrandom_v1";
export const ALGORITHM_VERSIONS: readonly AlgorithmVersion[] = ["hmac_sha256_v2", "seedrandom_v1"];
export const CRASH_VERSION = "crash_hmac_sha256_v1";
export const BLACKJACK_VERSION = "blackjack_hmac_sha256_card_v1";

export type KenoDifficulty = "CLASSIC" | "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
export const KENO_DIFFICULTIES: readonly KenoDifficulty[] = ["CLASSIC", "LOW", "MEDIUM", "HIGH", "EXTREME"];
export const KENO_BOARD: Readonly<Record<KenoDifficulty, { tileCount: number; drawCount: number }>> = {
  CLASSIC: { tileCount: 40, drawCount: 10 },
  LOW: { tileCount: 40, drawCount: 10 },
  MEDIUM: { tileCount: 40, drawCount: 10 },
  HIGH: { tileCount: 40, drawCount: 10 },
  EXTREME: { tileCount: 56, drawCount: 10 },
};
export const KENO_MIN_PICKS = 1;
export const KENO_MAX_PICKS = 10;

export const MINES_GRID_SIZES = [3, 5, 6, 7, 8] as const;
export type MinesGridSize = (typeof MINES_GRID_SIZES)[number];

/** Resource limits enforced on every API input (security: bounded memory and CPU per request). */
export const LIMITS = {
  seedLength: 4096,
  nonceLength: 128,
  textField: 512,
  blackjackCards: 520,
  listLength: 100,
  hmacParts: 32,
  hmacPartLength: 65536,
  importBytes: 50 * 1024 * 1024,
  importErrorsKept: 1000,
  htmlPdfExportRounds: 1000,
  jsonExportTraceRounds: 2000,
} as const;

export type OutcomeStatus = "reconstructed" | "match" | "mismatch" | "missing_comparison" | "invalid_input" | "unsupported_version";
export type CommitmentStatus = "verified" | "mismatch" | "not_supplied" | "scheme_unconfirmed";
export type CommitmentScheme = "unconfirmed" | "sha256_utf8_hex";
export type TimingStatus = "pre_round_publication_verified" | "publication_timing_unverified";
export type OverallStatus =
  | "verified_sufficient_evidence"
  | "match_commitment_unproven"
  | "reconstructed_only"
  | "mismatch"
  | "commitment_mismatch"
  | "incomplete"
  | "unsupported";

export interface TraceStep {
  section: string;
  label: string;
  value: string;
  note?: string;
}

export type ComparisonStatus = "match" | "mismatch" | "info" | "not_compared";
/** One row of the side-by-side "Reported vs Reconstructed" table. */
export interface ComparisonRow {
  field: string;
  reported: string | null;
  reconstructed: string | null;
  status: ComparisonStatus;
  note?: string;
}

export interface CommitmentResult {
  status: CommitmentStatus;
  scheme: CommitmentScheme;
  supplied: string | null;
  candidateSha256: string;
  candidateMatches: boolean | null;
  /** false when the supplied value is not a 64-character hex string */
  suppliedLooksLikeSha256: boolean | null;
  note: string;
}

export interface Card {
  label: string;
  suit: string;
}
export interface GeneratedCard extends Card {
  cardNumber: number;
  hash: string;
  h: number;
  rankIndex: number;
  suitIndex: number;
}

export interface CrashCalculated {
  multiplier: number;
  multiplierText: string;
  digest: string;
  mod20: number;
  instantCrash: boolean;
  h: number | null;
  e: number;
}
export interface BlackjackCalculated {
  cards: GeneratedCard[];
  cardCount: number;
}
export interface KenoCalculated {
  difficulty: KenoDifficulty;
  tileCount: number;
  drawn: number[];
  drawnSorted: number[];
  /** raw indices into the shrinking candidate list, in draw order */
  indices: number[];
  selectedNumbers: number[];
  matched: number[];
  matchCount: number;
  pickCount: number;
  orderMatches?: boolean;
}
export interface MinesCalculated {
  gridSize: number;
  tileCount: number;
  mineCount: number;
  mines: number[];
  minesSorted: number[];
  indices: number[];
  safe: number[];
  clickedTiles: number[];
  clickedMines: number[];
  derivedOutcome: "win" | "loss" | null;
}
export interface CalculatedByGame {
  crash: CrashCalculated;
  blackjack: BlackjackCalculated;
  keno: KenoCalculated;
  mines: MinesCalculated;
}

export interface VerificationResult<G extends Game = Game> {
  game: G | string;
  roundId: string | null;
  algorithmVersion: string | null;
  inputs: Record<string, unknown>;
  calculated: CalculatedByGame[G] | null;
  reported: Record<string, unknown> | null;
  outcome: { status: OutcomeStatus; details: string[] };
  comparisons: ComparisonRow[];
  commitment: CommitmentResult | { status: "not_supplied"; note: string };
  timing: { status: TimingStatus; note: string };
  payout: { status: "unavailable"; note: string } | null;
  overall: OverallStatus;
  errors: { field: string; message: string }[];
  trace: TraceStep[];
  computedAt: string;
  appVersion: string;
}

/** Lightweight row returned by list endpoints (no trace, no full result). */
export interface RoundSummary {
  id: number;
  roundId: string | null;
  game: string;
  algorithmVersion: string | null;
  nonce: string | null;
  serverSeed: string | null;
  clientSeed: string | null;
  outcomeStatus: OutcomeStatus;
  commitmentStatus: CommitmentStatus;
  timingStatus: TimingStatus;
  overallStatus: OverallStatus;
  evidenceSource: string | null;
  roundTimestamp: string | null;
  auditedAt: string;
  importBatchId: string | null;
  recordedSummary: string;
  calculatedSummary: string;
}

export interface PreviousAudit {
  auditedAt: string;
  overall: OverallStatus;
  outcome: OutcomeStatus;
  commitment: CommitmentStatus;
  appVersion: string;
}

export interface StoredRound extends RoundSummary {
  recorded: Record<string, unknown> | null;
  calculated: CalculatedByGame[Game] | null;
  result: VerificationResult;
  previousAudits: PreviousAudit[];
  /** true when the trace shown was recomputed from stored inputs rather than stored */
  traceRegenerated: boolean;
  /** recomputation from stored inputs reproduced the stored calculated outcome exactly */
  reproduced: boolean | null;
}

export interface Stats {
  metrics: Record<
    | "totalRounds" | "reconstructed" | "matching" | "mismatches" | "reconstructedOnly" | "commitmentMatches"
    | "commitmentMismatches" | "commitmentUnconfirmedScheme" | "missingCommitments" | "timingUnverified" | "invalidRecords",
    number
  >;
  byGame: ({ game: string } & Record<OutcomeStatus, number>)[];
  overTime: { date: string; match: number; mismatch: number; other: number }[];
  overall: Partial<Record<OverallStatus, number>>;
}

export type FindingKind = "contradiction" | "anomaly" | "data_quality";
export interface IntegrityFinding {
  check: string;
  kind: FindingKind;
  severity: "info" | "warning" | "attention";
  title: string;
  detail: string;
  roundIds: number[];
  totalRounds: number;
}
export interface IntegrityReport {
  checked: number;
  findings: IntegrityFinding[];
  truncated: boolean;
}

export type ImportJobStatus = "running" | "paused" | "completed" | "cancelled" | "failed" | "interrupted";
export interface ImportJob {
  id: string;
  status: ImportJobStatus;
  format: string;
  filename: string | null;
  total: number;
  processed: number;
  stored: number;
  rejected: number;
  duplicates: number;
  outcomeCounts: Partial<Record<OutcomeStatus, number>>;
  errors: { line: number; error: string }[];
  errorsTruncated: boolean;
  createdAt: string;
  finishedAt: string | null;
  failure: string | null;
}

export interface SeedSession {
  game: string;
  serverSeed: string;
  clientSeed: string;
  rounds: number;
  versions: string[];
  nonceMin: string | null;
  nonceMax: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  commitments: number;
  distinctCommitments: number;
  mismatches: number;
  sources: string[];
  conflicts: string[];
}

export interface Settings {
  commitmentScheme: CommitmentScheme;
  solanaRpcUrl: string;
}

export const STATUS_LABELS: Record<string, string> = {
  reconstructed: "Reconstructed",
  match: "Match",
  mismatch: "Mismatch",
  missing_comparison: "Missing comparison",
  invalid_input: "Invalid input",
  unsupported_version: "Unsupported version",
  verified: "Commitment verified",
  not_supplied: "No commitment supplied",
  scheme_unconfirmed: "Commitment scheme unconfirmed",
  pre_round_publication_verified: "Pre-round publication verified",
  publication_timing_unverified: "Publication timing unverified",
  verified_sufficient_evidence: "Verified with sufficient evidence",
  match_commitment_unproven: "Result matches, commitment timing unproven",
  reconstructed_only: "Reconstructed only",
  commitment_mismatch: "Commitment mismatch",
  incomplete: "Incomplete evidence",
  unsupported: "Unsupported algorithm",
};

export const OVERALL_EXPLANATIONS: Record<OverallStatus, string> = {
  verified_sufficient_evidence: "Outcome matches, commitment verified, and pre-round publication independently established.",
  match_commitment_unproven:
    "The recorded outcome is consistent with the revealed seeds. That the seeds were committed before the round is not proven.",
  reconstructed_only: "The outcome was calculated from the seeds, but there was no recorded outcome to compare against.",
  mismatch: "The recorded outcome does not agree with the independent calculation. Check inputs and algorithm version first.",
  commitment_mismatch: "The revealed server seed does not match the supplied commitment under the confirmed scheme.",
  incomplete: "Inputs are missing or invalid, so nothing could be verified.",
  unsupported: "The requested algorithm version is not supported.",
};

export const VERSION_LABELS: Record<string, string> = {
  hmac_sha256_v2: "HMAC SHA256 V2 (current)",
  seedrandom_v1: "Seedrandom V1 (legacy)",
  crash_hmac_sha256_v1: "Crash HMAC-SHA256",
  blackjack_hmac_sha256_card_v1: "Blackjack per-card HMAC",
};
