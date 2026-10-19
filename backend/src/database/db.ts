import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeOutcome } from "../../../shared/src/parsing.js";
import type {
  CalculatedByGame,
  CommitmentStatus,
  Game,
  ImportJob,
  ImportJobStatus,
  OutcomeStatus,
  OverallStatus,
  PreviousAudit,
  RoundSummary,
  SeedSession,
  Settings,
  StoredRound,
  TimingStatus,
  VerificationResult,
} from "../../../shared/src/contracts.js";
import { MIGRATIONS, SCHEMA_VERSION, V0_SCHEMA } from "./migrations.js";

export type { Settings, StoredRound } from "../../../shared/src/contracts.js";

const DEFAULT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/fairness-lab.db");

const DEFAULT_SETTINGS: Settings = {
  commitmentScheme: "unconfirmed",
  solanaRpcUrl: "https://api.mainnet-beta.solana.com",
};

export interface RoundFilter {
  game?: string;
  status?: string;
  outcome?: string;
  batch?: string;
  q?: string;
  ids?: number[];
  limit?: number;
  offset?: number;
}

/** Stable JSON with sorted keys (used for fingerprints). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Metadata that does not change what a round *is* (where/when it was recorded) is excluded. */
const NON_IDENTITY = new Set(["source", "timestamp", "txSignature"]);
export function fingerprintOf(inputs: Record<string, unknown>): string {
  const core: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) if (!NON_IDENTITY.has(k) && v !== null && v !== "") core[k] = v;
  return createHash("sha256").update(canonicalJson(core)).digest("hex");
}

/**
 * Imported rounds store only authoritative facts (outcome + details, overall, errors, audit time).
 * Statuses live in their own columns; explanatory notes, comparison rows and the trace are
 * deterministic presentation and are rebuilt from the inputs when the record is opened.
 * This halves the row size (~1.9 KB -> ~0.6 KB of JSON) and import write volume.
 */
function compactResult(r: VerificationResult) {
  return { compact: true, outcome: r.outcome, overall: r.overall, errors: r.errors, computedAt: r.computedAt, appVersion: r.appVersion };
}

const SUMMARY_COLUMNS =
  "id, round_id, game, algorithm_version, nonce, server_seed, client_seed, outcome_status, commitment_status, timing_status, overall_status, evidence_source, round_timestamp, audited_at, import_batch_id, recorded_json, calculated_json";

export class FairnessDb {
  readonly db: DatabaseSync;
  readonly path: string;
  /** set when opening this database required a schema migration */
  readonly migration: { from: number; to: number; backup: string | null } | null = null;
  /** incremented on every write; lets callers cache derived data (stats, integrity) safely */
  revision = 0;
  private statements = new Map<string, StatementSync>();

  /** Prepared-statement cache: compiling SQL on every row cost ~25% of import time. */
  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  constructor(path = process.env.SFL_DB_PATH ?? DEFAULT_PATH) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL + synchronous=NORMAL: never corrupts; an application crash loses nothing; an OS crash or power loss can
    // lose only the most recent commits. Per-commit fsync (FULL) made imports ~2x slower on Windows.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    // 64 MB page cache (default 2 MB): random fingerprint keys made index pages thrash past ~50k rows.
    this.db.exec("PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY;");
    // base (v0) schema only for new or legacy files; later versions are reached through migrations
    if (this.schemaVersion === 0) this.db.exec(V0_SCHEMA);
    this.migration = this.migrate();
    // Jobs that were running when the process stopped can never resume; mark them honestly.
    this.db.prepare("UPDATE imports SET status = 'interrupted', finished_at = ? WHERE status IN ('running','paused')").run(new Date().toISOString());
  }

  get schemaVersion(): number {
    return (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  /**
   * Forward migration with a backup taken first whenever the database already holds data.
   * Each migration runs in a single transaction: it either fully applies or leaves the file untouched.
   */
  private migrate(): { from: number; to: number; backup: string | null } | null {
    const from = this.schemaVersion;
    if (from > SCHEMA_VERSION) {
      throw new Error(`Database schema v${from} is newer than this application (v${SCHEMA_VERSION}). Refusing to modify it; use a newer version of the app.`);
    }
    if (from === SCHEMA_VERSION) return null;
    let backup: string | null = null;
    const hasData = (this.db.prepare("SELECT (SELECT COUNT(*) FROM rounds) + (SELECT COUNT(*) FROM imports) AS n").get() as { n: number }).n > 0;
    if (hasData && this.path !== ":memory:") backup = this.backup(`pre-v${SCHEMA_VERSION}`);
    for (const m of MIGRATIONS.filter((x) => x.version > from)) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        m.up(this.db);
        this.db.exec(`PRAGMA user_version = ${m.version}`);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw new Error(`Migration to v${m.version} failed and was rolled back${backup ? `; backup at ${backup}` : ""}: ${(e as Error).message}`);
      }
    }
    return { from, to: SCHEMA_VERSION, backup };
  }

  /** Reverts to schema `target` (used by tests and documented as the rollback path). */
  migrateDown(target: number) {
    for (const m of [...MIGRATIONS].reverse().filter((x) => x.version > target && x.version <= this.schemaVersion)) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        m.down(this.db);
        this.db.exec(`PRAGMA user_version = ${m.version - 1}`);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  /** Consistent online snapshot via VACUUM INTO. Returns the backup path. */
  backup(tag = "manual"): string {
    if (this.path === ":memory:") throw new Error("in-memory database cannot be backed up");
    const dir = join(dirname(this.path), "backups");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `fairness-lab-${tag}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
    if (existsSync(file)) throw new Error("backup already exists");
    this.db.prepare("VACUUM INTO ?").run(file);
    return file;
  }

  /* ------------------------------------------------------------------ settings */
  getSettings(): Settings {
    const rows = this.stmt("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (r.key in DEFAULT_SETTINGS) s[r.key] = JSON.parse(r.value);
    return s as unknown as Settings;
  }

  setSettings(patch: Partial<Settings>) {
    const stmt = this.db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) stmt.run(k, JSON.stringify(v));
    return this.getSettings();
  }

  /* ------------------------------------------------------------------ rounds */
  findByFingerprint(fp: string): number | null {
    const r = this.stmt("SELECT id FROM rounds WHERE fingerprint = ? LIMIT 1").get(fp) as { id: number } | undefined;
    return r?.id ?? null;
  }

  /**
   * Stores a verification. Inputs, recorded outcome and calculated outcome live in their own
   * columns; result_json holds the rest (statuses, comparisons, commitment, and the trace only
   * when `storeTrace`). Traces of imported rounds are regenerated on demand from the inputs.
   */
  insertRound(result: VerificationResult, importBatchId: string | null = null, storeTrace = true): number {
    const inputs = (result.inputs ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : v == null ? null : String(v));
    const { inputs: _i, calculated, reported, trace, ...rest } = result;
    void _i;
    this.revision++;
    const info = this
      .stmt(
        `INSERT INTO rounds (round_id, game, algorithm_version, nonce, server_seed, client_seed, outcome_status, commitment_status,
          timing_status, overall_status, evidence_source, round_timestamp, audited_at, import_batch_id, inputs_json, recorded_json,
          calculated_json, result_json, fingerprint, commitment, trace_stored) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        result.roundId,
        String(result.game),
        result.algorithmVersion,
        str(inputs.nonce),
        str(inputs.serverSeed),
        str(inputs.clientSeed),
        result.outcome.status,
        result.commitment.status,
        result.timing.status,
        result.overall,
        str(inputs.source),
        str(inputs.timestamp),
        result.computedAt,
        importBatchId,
        JSON.stringify(inputs),
        reported ? JSON.stringify(reported) : null,
        calculated ? JSON.stringify(calculated) : null,
        JSON.stringify(storeTrace ? { ...rest, trace } : compactResult(result)),
        fingerprintOf(inputs),
        typeof inputs.commitment === "string" && inputs.commitment ? inputs.commitment.trim().toLowerCase() : null,
        storeTrace ? 1 : 0,
      );
    return Number(info.lastInsertRowid);
  }

  /** Re-audit: replaces the current statuses and keeps the previous audit in previous_audits_json (never silently lost). */
  updateRoundResult(id: number, result: VerificationResult) {
    this.revision++;
    const cur = this.db.prepare("SELECT overall_status, outcome_status, commitment_status, audited_at, result_json, previous_audits_json FROM rounds WHERE id = ?").get(id) as
      | Record<string, string>
      | undefined;
    if (!cur) return false;
    const prev: PreviousAudit[] = cur.previous_audits_json ? JSON.parse(cur.previous_audits_json) : [];
    prev.push({
      auditedAt: cur.audited_at,
      overall: cur.overall_status as OverallStatus,
      outcome: cur.outcome_status as OutcomeStatus,
      commitment: cur.commitment_status as CommitmentStatus,
      appVersion: (JSON.parse(cur.result_json) as { appVersion?: string }).appVersion ?? "1.0.0",
    });
    const storedTrace = this.db.prepare("SELECT trace_stored FROM rounds WHERE id = ?").get(id) as { trace_stored: number };
    const { inputs: _i, calculated, reported, trace, ...rest } = result;
    void _i;
    this.db
      .prepare(
        `UPDATE rounds SET outcome_status=?, commitment_status=?, timing_status=?, overall_status=?, audited_at=?, recorded_json=?,
         calculated_json=?, result_json=?, previous_audits_json=? WHERE id=?`,
      )
      .run(
        result.outcome.status,
        result.commitment.status,
        result.timing.status,
        result.overall,
        result.computedAt,
        reported ? JSON.stringify(reported) : null,
        calculated ? JSON.stringify(calculated) : null,
        JSON.stringify(storedTrace.trace_stored ? { ...rest, trace } : compactResult(result)),
        JSON.stringify(prev),
        id,
      );
    return true;
  }

  private where(f: RoundFilter): { clause: string; params: SQLInputValue[] } {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    const eq = (column: string, value: string | undefined) => {
      if (!value) return;
      where.push(`${column} = ?`);
      params.push(value);
    };
    eq("game", f.game);
    eq("overall_status", f.status);
    eq("outcome_status", f.outcome);
    eq("import_batch_id", f.batch);
    if (f.q) {
      // LIKE metacharacters in the user's text are literal (audit S-04)
      const like = `%${f.q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      where.push("(round_id LIKE ? ESCAPE '\\' OR server_seed LIKE ? ESCAPE '\\' OR client_seed LIKE ? ESCAPE '\\' OR nonce LIKE ? ESCAPE '\\' OR evidence_source LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like, like);
    }
    if (f.ids?.length) {
      where.push(`id IN (${f.ids.map(() => "?").join(",")})`);
      params.push(...f.ids);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }

  private toSummary(r: Record<string, unknown>): RoundSummary {
    const game = r.game as string;
    return {
      id: r.id as number,
      roundId: r.round_id as string | null,
      game,
      algorithmVersion: r.algorithm_version as string | null,
      nonce: r.nonce as string | null,
      serverSeed: r.server_seed as string | null,
      clientSeed: r.client_seed as string | null,
      outcomeStatus: r.outcome_status as OutcomeStatus,
      commitmentStatus: r.commitment_status as CommitmentStatus,
      timingStatus: r.timing_status as TimingStatus,
      overallStatus: r.overall_status as OverallStatus,
      evidenceSource: r.evidence_source as string | null,
      roundTimestamp: r.round_timestamp as string | null,
      auditedAt: r.audited_at as string,
      importBatchId: r.import_batch_id as string | null,
      recordedSummary: r.recorded_json ? summarizeOutcome(game, JSON.parse(r.recorded_json as string)) : "",
      calculatedSummary: r.calculated_json ? summarizeOutcome(game, JSON.parse(r.calculated_json as string)) : "",
    };
  }

  countRounds(f: RoundFilter = {}): number {
    const { clause, params } = this.where(f);
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM rounds ${clause}`).get(...params) as { n: number }).n;
  }

  /** Lightweight paginated listing (no traces or full results). */
  listSummaries(f: RoundFilter = {}): { total: number; rounds: RoundSummary[] } {
    const { clause, params } = this.where(f);
    const total = this.countRounds(f);
    const rows = this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM rounds ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, f.limit ?? 50, f.offset ?? 0);
    return { total, rounds: (rows as Record<string, unknown>[]).map((r) => this.toSummary(r)) };
  }

  /** Streams lightweight rows (used by the CSV export so memory stays flat for any size). */
  *iterateSummaries(f: RoundFilter = {}): Generator<RoundSummary> {
    const { clause, params } = this.where(f);
    const stmt = this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM rounds ${clause} ORDER BY id DESC`);
    for (const r of stmt.iterate(...params)) yield this.toSummary(r as Record<string, unknown>);
  }

  private toStored(r: Record<string, unknown>): StoredRound {
    const summary = this.toSummary(r);
    const stored = JSON.parse(r.result_json as string) as Partial<VerificationResult>;
    const inputs = JSON.parse(r.inputs_json as string) as Record<string, unknown>;
    const recorded = r.recorded_json ? JSON.parse(r.recorded_json as string) : null;
    const calculated = r.calculated_json ? (JSON.parse(r.calculated_json as string) as CalculatedByGame[Game]) : null;
    // v1 rows stored everything (incl. inputs/trace) inside result_json; v2 rows store them in columns.
    const isCompact = (stored as { compact?: boolean }).compact === true;
    const result = {
      game: summary.game,
      roundId: summary.roundId,
      algorithmVersion: summary.algorithmVersion,
      ...(isCompact
        ? {
            commitment: { status: summary.commitmentStatus, note: "" },
            timing: { status: summary.timingStatus, note: "" },
            payout: null,
          }
        : {}),
      ...stored,
      inputs: stored.inputs ?? inputs,
      reported: stored.reported ?? recorded,
      calculated: stored.calculated ?? calculated,
      trace: stored.trace ?? [],
      comparisons: stored.comparisons ?? [],
      // the column is authoritative (migrations may remap statuses)
      overall: summary.overallStatus,
    } as VerificationResult;
    return {
      ...summary,
      recorded,
      calculated,
      result,
      previousAudits: r.previous_audits_json ? JSON.parse(r.previous_audits_json as string) : [],
      traceRegenerated: false,
      reproduced: null,
      compact: isCompact,
    };
  }

  /** Full records; used for detail views and bounded exports. Iterates lazily. */
  *iterateRounds(f: RoundFilter = {}): Generator<StoredRound> {
    const { clause, params } = this.where(f);
    const stmt = this.db.prepare(`SELECT * FROM rounds ${clause} ORDER BY id DESC ${f.limit ? "LIMIT ?" : ""}`);
    for (const r of stmt.iterate(...params, ...(f.limit ? [f.limit] : []))) yield this.toStored(r as Record<string, unknown>);
  }

  getRound(id: number): StoredRound | null {
    const r = this.stmt("SELECT * FROM rounds WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.toStored(r) : null;
  }

  deleteRound(id: number) {
    this.revision++;
    return Number(this.db.prepare("DELETE FROM rounds WHERE id = ?").run(id).changes);
  }

  /* ------------------------------------------------------------------ aggregation (SQL, no JSON parsing) */
  stats(f: RoundFilter = {}) {
    const { clause, params } = this.where(f);
    const m = this.db
      .prepare(
        `SELECT COUNT(*) AS totalRounds,
           COALESCE(SUM(outcome_status NOT IN ('invalid_input','unsupported_version')),0) AS reconstructed,
           COALESCE(SUM(outcome_status = 'match'),0) AS matching,
           COALESCE(SUM(outcome_status = 'mismatch'),0) AS mismatches,
           COALESCE(SUM(outcome_status IN ('reconstructed','missing_comparison')),0) AS reconstructedOnly,
           COALESCE(SUM(commitment_status = 'verified'),0) AS commitmentMatches,
           COALESCE(SUM(commitment_status = 'mismatch'),0) AS commitmentMismatches,
           COALESCE(SUM(commitment_status = 'scheme_unconfirmed'),0) AS commitmentUnconfirmedScheme,
           COALESCE(SUM(commitment_status = 'not_supplied'),0) AS missingCommitments,
           COALESCE(SUM(timing_status <> 'pre_round_publication_verified'),0) AS timingUnverified,
           COALESCE(SUM(outcome_status IN ('invalid_input','unsupported_version')),0) AS invalidRecords
         FROM rounds ${clause}`,
      )
      .get(...params) as Record<string, number>;

    const statuses: OutcomeStatus[] = ["match", "mismatch", "reconstructed", "missing_comparison", "invalid_input", "unsupported_version"];
    const byGameRows = this.db.prepare(`SELECT game, outcome_status AS s, COUNT(*) AS n FROM rounds ${clause} GROUP BY game, outcome_status`).all(...params) as {
      game: string;
      s: OutcomeStatus;
      n: number;
    }[];
    const byGame = ["crash", "blackjack", "keno", "mines"].map((game) => {
      const row = { game } as { game: string } & Record<OutcomeStatus, number>;
      for (const s of statuses) row[s] = byGameRows.find((x) => x.game === game && x.s === s)?.n ?? 0;
      return row;
    });
    const overTime = this.db
      .prepare(
        `SELECT COALESCE(date(round_timestamp), date(audited_at)) AS date,
           SUM(outcome_status = 'match') AS match, SUM(outcome_status = 'mismatch') AS mismatch,
           SUM(outcome_status NOT IN ('match','mismatch')) AS other
         FROM rounds ${clause} GROUP BY 1 ORDER BY 1`,
      )
      .all(...params) as { date: string; match: number; mismatch: number; other: number }[];
    const overall: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT overall_status AS s, COUNT(*) AS n FROM rounds ${clause} GROUP BY 1`).all(...params) as { s: string; n: number }[]) {
      overall[r.s] = r.n;
    }
    return { metrics: m, byGame, overTime, overall };
  }

  seedSessions(f: { game?: string; limit?: number; offset?: number } = {}): { total: number; sessions: SeedSession[] } {
    const where = "WHERE server_seed IS NOT NULL AND server_seed <> ''" + (f.game ? " AND game = ?" : "");
    const params: SQLInputValue[] = f.game ? [f.game] : [];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM rounds ${where} GROUP BY game, server_seed, client_seed)`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(
        `SELECT game, server_seed, client_seed, COUNT(*) AS rounds,
           group_concat(DISTINCT algorithm_version) AS versions,
           MIN(CASE WHEN nonce NOT GLOB '*[^0-9]*' AND nonce <> '' THEN CAST(nonce AS INTEGER) END) AS nmin,
           MAX(CASE WHEN nonce NOT GLOB '*[^0-9]*' AND nonce <> '' THEN CAST(nonce AS INTEGER) END) AS nmax,
           MIN(round_timestamp) AS first_seen, MAX(round_timestamp) AS last_seen,
           SUM(commitment IS NOT NULL) AS commitments, COUNT(DISTINCT commitment) AS distinct_commitments,
           SUM(outcome_status = 'mismatch') AS mismatches,
           group_concat(DISTINCT evidence_source) AS sources,
           COUNT(*) - COUNT(DISTINCT COALESCE(nonce, '#' || id)) AS nonce_repeats
         FROM rounds ${where}
         GROUP BY game, server_seed, client_seed
         ORDER BY MAX(id) DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, f.limit ?? 50, f.offset ?? 0) as Record<string, string | number | null>[];
    const split = (v: unknown) => (typeof v === "string" && v ? v.split(",") : []);
    return {
      total,
      sessions: rows.map((r) => {
        const conflicts: string[] = [];
        if (Number(r.distinct_commitments) > 1) conflicts.push(`${r.distinct_commitments} different commitments recorded for one server seed`);
        if (split(r.versions).length > 1) conflicts.push("mixed algorithm versions");
        if (Number(r.nonce_repeats) > 0 && (r.game === "keno" || r.game === "mines")) conflicts.push(`${r.nonce_repeats} repeated nonce(s)`);
        if (Number(r.mismatches) > 0) conflicts.push(`${r.mismatches} outcome mismatch(es)`);
        return {
          game: String(r.game),
          serverSeed: String(r.server_seed),
          clientSeed: String(r.client_seed ?? ""),
          rounds: Number(r.rounds),
          versions: split(r.versions),
          nonceMin: r.nmin === null ? null : String(r.nmin),
          nonceMax: r.nmax === null ? null : String(r.nmax),
          firstSeen: (r.first_seen as string | null) ?? null,
          lastSeen: (r.last_seen as string | null) ?? null,
          commitments: Number(r.commitments),
          distinctCommitments: Number(r.distinct_commitments),
          mismatches: Number(r.mismatches),
          sources: split(r.sources),
          conflicts,
        };
      }),
    };
  }

  /* ------------------------------------------------------------------ imports */
  createImport(job: ImportJob) {
    this.db
      .prepare("INSERT INTO imports (id, created_at, format, filename, total, stored, rejected, errors_json, status, processed, duplicates) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(job.id, job.createdAt, job.format, job.filename, job.total, 0, 0, "[]", job.status, 0, 0);
  }

  updateImport(job: ImportJob) {
    this.db
      .prepare("UPDATE imports SET total=?, stored=?, rejected=?, errors_json=?, status=?, processed=?, duplicates=?, finished_at=?, outcome_counts_json=?, failure=? WHERE id=?")
      .run(job.total, job.stored, job.rejected, JSON.stringify(job.errors), job.status, job.processed, job.duplicates, job.finishedAt, JSON.stringify(job.outcomeCounts), job.failure, job.id);
  }

  listImports(limit = 50): ImportJob[] {
    return (this.db.prepare("SELECT * FROM imports ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((r) => this.toImport(r));
  }

  getImport(id: string): ImportJob | null {
    const r = this.db.prepare("SELECT * FROM imports WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.toImport(r) : null;
  }

  private toImport(r: Record<string, unknown>): ImportJob {
    const errors = JSON.parse((r.errors_json as string) || "[]");
    return {
      id: r.id as string,
      status: (r.status as ImportJobStatus) ?? "completed",
      format: r.format as string,
      filename: (r.filename as string | null) ?? null,
      total: Number(r.total),
      processed: Number(r.processed ?? r.total),
      stored: Number(r.stored),
      rejected: Number(r.rejected),
      duplicates: Number(r.duplicates ?? 0),
      outcomeCounts: r.outcome_counts_json ? JSON.parse(r.outcome_counts_json as string) : {},
      errors,
      errorsTruncated: Number(r.rejected) > errors.length,
      createdAt: r.created_at as string,
      finishedAt: (r.finished_at as string | null) ?? null,
      failure: (r.failure as string | null) ?? null,
    };
  }
}
