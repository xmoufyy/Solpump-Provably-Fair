import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { Sql, type Param, type Statement } from "./sql.js";
import { NUMERIC_NONCE_KEY, nonceFromKey } from "../auditing/integrity.js";

export type { Settings, StoredRound } from "../../../shared/src/contracts.js";

const DEFAULT_SETTINGS: Settings = {
  commitmentScheme: "unconfirmed",
  solanaRpcUrl: "https://api.mainnet-beta.solana.com",
};

/** A running import with no chunk received for this long is shown as interrupted (its uploader stopped). */
export const IMPORT_STALE_MS = 10 * 60 * 1000;

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

/** Rows per page when streaming large result sets (keyset pagination keeps memory flat, locally and hosted). */
const PAGE = 1000;

/** Where the database lives: a hosted libSQL/Turso URL when configured, otherwise the local SQLite file in SFL_DB_PATH. */
export function databaseLocation(): { url: string; authToken?: string } {
  const remote = process.env.TURSO_DATABASE_URL ?? process.env.SFL_DB_URL;
  if (remote) return { url: remote, authToken: process.env.TURSO_AUTH_TOKEN };
  // Serverless file systems are read-only or discarded between requests: records written there would be lost.
  if (process.env.VERCEL) throw new Error("No database configured: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN for this deployment.");
  // The local default (data/fairness-lab.db) is set by the local entry point, server.ts. It is deliberately not
  // referenced here, so deployment bundlers that trace file paths from this module never pack a local database.
  if (!process.env.SFL_DB_PATH) throw new Error("No database configured: set SFL_DB_PATH (local file) or TURSO_DATABASE_URL (hosted).");
  return { url: process.env.SFL_DB_PATH };
}

export class FairnessDb {
  /** set when opening this database required a schema migration */
  migration: { from: number; to: number; backup: string | null } | null = null;

  private constructor(readonly sql: Sql) {}

  /**
   * Opens (creating and migrating if needed) a database: a file path, ":memory:", a remote libSQL URL,
   * or an existing connection (tests).
   */
  static async open(location: string | { url: string; authToken?: string } | Sql = databaseLocation()): Promise<FairnessDb> {
    let sql: Sql;
    if (location instanceof Sql) sql = location;
    else {
      const { url, authToken } = typeof location === "string" ? { url: location, authToken: undefined } : location;
      const isRemote = /^(libsql|https?|wss?):\/\//i.test(url);
      if (!isRemote && url !== ":memory:") mkdirSync(dirname(url.replace(/^file:/, "")), { recursive: true });
      sql = Sql.connect(url, authToken);
    }
    const db = new FairnessDb(sql);
    if (db.sql.local) {
      // WAL + synchronous=NORMAL: never corrupts; an application crash loses nothing; an OS crash or power loss can
      // lose only the most recent commits. Per-commit fsync (FULL) made imports ~2x slower on Windows.
      await db.sql.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      // 64 MB page cache (default 2 MB): random fingerprint keys made index pages thrash past ~50k rows.
      await db.sql.exec("PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY;");
    }
    await db.ensureVersionRecord();
    // base (v0) schema only for new or legacy files; later versions are reached through migrations
    if ((await db.schemaVersion()) === 0) await db.sql.exec(V0_SCHEMA);
    db.migration = await db.migrate();
    return db;
  }

  get local(): boolean {
    return this.sql.local;
  }

  close() {
    this.sql.close();
  }

  /**
   * The schema version lives in the schema_meta table: hosted libSQL (Turso) refuses to write
   * PRAGMA user_version. Local files written by earlier versions recorded it only in user_version, which
   * seeds the table once; local files keep user_version in step so older app versions still recognise them.
   */
  private async ensureVersionRecord() {
    await this.sql.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    const legacy = this.sql.local ? Number((await this.sql.get<{ user_version: number }>("PRAGMA user_version"))?.user_version ?? 0) : 0;
    await this.sql.run("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', ?)", legacy);
  }

  async schemaVersion(): Promise<number> {
    return Number((await this.sql.get<{ value: number }>("SELECT value FROM schema_meta WHERE key = 'schema_version'"))?.value ?? 0);
  }

  /** Statements recording `version`; batched with a migration so both apply together or not at all. */
  private versionStatements(version: number): Statement[] {
    return [
      { sql: "UPDATE schema_meta SET value = ? WHERE key = 'schema_version'", args: [version] },
      ...(this.sql.local ? [{ sql: `PRAGMA user_version = ${version}` }] : []),
    ];
  }

  /**
   * Forward migration with a backup taken first whenever a local database already holds data.
   * Each migration runs in one atomic batch: it either fully applies or leaves the database untouched.
   */
  private async migrate(): Promise<{ from: number; to: number; backup: string | null } | null> {
    const from = await this.schemaVersion();
    if (from > SCHEMA_VERSION) {
      throw new Error(`Database schema v${from} is newer than this application (v${SCHEMA_VERSION}). Refusing to modify it; use a newer version of the app.`);
    }
    if (from === SCHEMA_VERSION) return null;
    let backup: string | null = null;
    const hasData = Number((await this.sql.get<{ n: number }>("SELECT (SELECT COUNT(*) FROM rounds) + (SELECT COUNT(*) FROM imports) AS n"))?.n) > 0;
    if (hasData && this.sql.file !== null) backup = await this.backup(`pre-v${SCHEMA_VERSION}`);
    for (const m of MIGRATIONS.filter((x) => x.version > from)) {
      try {
        await this.sql.batch([...(await m.up(this.sql)), ...this.versionStatements(m.version)]);
      } catch (e) {
        throw new Error(`Migration to v${m.version} failed and was rolled back${backup ? `; backup at ${backup}` : ""}: ${(e as Error).message}`);
      }
    }
    return { from, to: SCHEMA_VERSION, backup };
  }

  /** Reverts to schema `target` (used by tests and documented as the rollback path). */
  async migrateDown(target: number) {
    const current = await this.schemaVersion();
    for (const m of [...MIGRATIONS].reverse().filter((x) => x.version > target && x.version <= current)) {
      await this.sql.batch([...(await m.down(this.sql)), ...this.versionStatements(m.version - 1)]);
    }
  }

  /** Consistent online snapshot of a local database via VACUUM INTO. Returns the backup path. */
  async backup(tag = "manual"): Promise<string> {
    if (this.sql.file === null) {
      throw new Error(
        this.sql.local
          ? "An in-memory database cannot be backed up."
          : "This is a hosted database: backups and point-in-time restore are provided by the database service (Turso dashboard or CLI). Use the JSON export for a portable copy of the records.",
      );
    }
    const dir = join(dirname(this.sql.file), "backups");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `fairness-lab-${tag}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
    if (existsSync(file)) throw new Error("backup already exists");
    await this.sql.run("VACUUM INTO ?", file);
    return file;
  }

  /**
   * Changes whenever round data changes (insert, re-audit, delete). Derived views (stats, integrity) are cached
   * against it. It is read from the database rather than kept in memory so that several server instances
   * (serverless) can never serve each other's stale results. Re-audits always write a newer audited_at.
   */
  async dataVersion(): Promise<string> {
    const r = await this.sql.get<Record<string, unknown>>("SELECT COUNT(*) AS n, MAX(id) AS id, MAX(audited_at) AS at FROM rounds");
    return `${r?.n}:${r?.id}:${r?.at}`;
  }

  /* ------------------------------------------------------------------ settings */
  async getSettings(): Promise<Settings> {
    const rows = await this.sql.all<{ key: string; value: string }>("SELECT key, value FROM settings");
    const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (r.key in DEFAULT_SETTINGS) s[r.key] = JSON.parse(r.value);
    return s as unknown as Settings;
  }

  async setSettings(patch: Partial<Settings>) {
    await this.sql.batch(
      Object.entries(patch)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => ({ sql: "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [k, JSON.stringify(v)] })),
    );
    return this.getSettings();
  }

  /* ------------------------------------------------------------------ rounds */
  async findByFingerprint(fp: string): Promise<number | null> {
    const r = await this.sql.get<{ id: number }>("SELECT id FROM rounds WHERE fingerprint = ? LIMIT 1", fp);
    return r?.id ?? null;
  }

  /** Which of these fingerprints are already stored (looked up in bounded groups). */
  async existingFingerprints(fps: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    const unique = [...new Set(fps)];
    for (let i = 0; i < unique.length; i += 500) {
      const group = unique.slice(i, i + 500);
      const rows = await this.sql.all<{ fingerprint: string }>(`SELECT DISTINCT fingerprint FROM rounds WHERE fingerprint IN (${group.map(() => "?").join(",")})`, ...group);
      for (const r of rows) found.add(r.fingerprint);
    }
    return found;
  }

  /**
   * The INSERT for a verification. Inputs, recorded outcome and calculated outcome live in their own
   * columns; result_json holds the rest (statuses, comparisons, commitment, and the trace only when
   * `storeTrace`). Traces of imported rounds are regenerated on demand from the inputs.
   */
  insertStatement(result: VerificationResult, importBatchId: string | null = null, storeTrace = true): Statement {
    const inputs = (result.inputs ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : v == null ? null : String(v));
    const { inputs: _i, calculated, reported, trace, ...rest } = result;
    void _i;
    return {
      sql: `INSERT INTO rounds (round_id, game, algorithm_version, nonce, server_seed, client_seed, outcome_status, commitment_status,
          timing_status, overall_status, evidence_source, round_timestamp, audited_at, import_batch_id, inputs_json, recorded_json,
          calculated_json, result_json, fingerprint, commitment, trace_stored) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
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
      ],
    };
  }

  async insertRound(result: VerificationResult, importBatchId: string | null = null, storeTrace = true): Promise<number> {
    return (await this.sql.run(...toArgs(this.insertStatement(result, importBatchId, storeTrace)))).lastInsertRowid;
  }

  /**
   * The UPDATE for a re-audit: replaces the current statuses and appends the previous audit to
   * previous_audits_json (never silently lost). Built from the record as read, so many re-audits can be
   * written in one atomic batch.
   */
  reauditStatement(current: StoredRound, result: VerificationResult): Statement {
    const prev: PreviousAudit[] = [
      ...current.previousAudits,
      {
        auditedAt: current.auditedAt,
        overall: current.overallStatus,
        outcome: current.outcomeStatus,
        commitment: current.commitmentStatus,
        appVersion: current.result.appVersion ?? "1.0.0",
      },
    ];
    const { inputs: _i, calculated, reported, trace, ...rest } = result;
    void _i;
    return {
      sql: `UPDATE rounds SET outcome_status=?, commitment_status=?, timing_status=?, overall_status=?, audited_at=?, recorded_json=?,
         calculated_json=?, result_json=?, previous_audits_json=? WHERE id=?`,
      args: [
        result.outcome.status,
        result.commitment.status,
        result.timing.status,
        result.overall,
        result.computedAt,
        reported ? JSON.stringify(reported) : null,
        calculated ? JSON.stringify(calculated) : null,
        JSON.stringify(current.compact ? compactResult(result) : { ...rest, trace }),
        JSON.stringify(prev),
        current.id,
      ],
    };
  }

  async updateRoundResult(id: number, result: VerificationResult): Promise<boolean> {
    const current = await this.getRound(id);
    if (!current) return false;
    await this.sql.run(...toArgs(this.reauditStatement(current, result)));
    return true;
  }

  private where(f: RoundFilter): { clause: string; params: Param[] } {
    const where: string[] = [];
    const params: Param[] = [];
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
      id: Number(r.id),
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

  async countRounds(f: RoundFilter = {}): Promise<number> {
    const { clause, params } = this.where(f);
    return Number((await this.sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM rounds ${clause}`, ...params))?.n ?? 0);
  }

  /** Lightweight paginated listing (no traces or full results). */
  async listSummaries(f: RoundFilter = {}): Promise<{ total: number; rounds: RoundSummary[] }> {
    const { clause, params } = this.where(f);
    const total = await this.countRounds(f);
    const rows = await this.sql.all(`SELECT ${SUMMARY_COLUMNS} FROM rounds ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, f.limit ?? 50, f.offset ?? 0);
    return { total, rounds: rows.map((r) => this.toSummary(r)) };
  }

  /** Newest-first keyset pagination over a filter: memory stays flat for any size. */
  private async *pages(columns: string, f: RoundFilter): AsyncGenerator<Record<string, unknown>> {
    const { clause, params } = this.where(f);
    let before = Number.MAX_SAFE_INTEGER;
    let remaining = f.limit ?? Infinity;
    while (remaining > 0) {
      const size = Math.min(PAGE, remaining);
      const rows = await this.sql.all(
        `SELECT ${columns} FROM rounds ${clause ? `${clause} AND` : "WHERE"} id < ? ORDER BY id DESC LIMIT ?`,
        ...params,
        before,
        size,
      );
      for (const r of rows) yield r;
      if (rows.length < size) return;
      before = Number(rows[rows.length - 1].id);
      remaining -= rows.length;
    }
  }

  /** Streams lightweight rows (used by the CSV export). */
  async *iterateSummaries(f: RoundFilter = {}): AsyncGenerator<RoundSummary> {
    for await (const r of this.pages(SUMMARY_COLUMNS, f)) yield this.toSummary(r);
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

  /** Full records; used for detail views, re-audits and bounded exports. Iterates lazily, page by page. */
  async *iterateRounds(f: RoundFilter = {}): AsyncGenerator<StoredRound> {
    for await (const r of this.pages("*", f)) yield this.toStored(r);
  }

  async getRound(id: number): Promise<StoredRound | null> {
    const r = await this.sql.get("SELECT * FROM rounds WHERE id = ?", id);
    return r ? this.toStored(r) : null;
  }

  async deleteRound(id: number): Promise<number> {
    return (await this.sql.run("DELETE FROM rounds WHERE id = ?", id)).changes;
  }

  /* ------------------------------------------------------------------ aggregation (SQL, no JSON parsing) */
  async stats(f: RoundFilter = {}) {
    const { clause, params } = this.where(f);
    const raw = await this.sql.get<Record<string, unknown>>(
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
      ...params,
    );
    const m = Object.fromEntries(Object.entries(raw ?? {}).map(([k, v]) => [k, Number(v)])) as Record<string, number>;

    const statuses: OutcomeStatus[] = ["match", "mismatch", "reconstructed", "missing_comparison", "invalid_input", "unsupported_version"];
    const byGameRows = await this.sql.all<{ game: string; s: OutcomeStatus; n: number }>(
      `SELECT game, outcome_status AS s, COUNT(*) AS n FROM rounds ${clause} GROUP BY game, outcome_status`,
      ...params,
    );
    const byGame = ["crash", "blackjack", "keno", "mines"].map((game) => {
      const row = { game } as { game: string } & Record<OutcomeStatus, number>;
      for (const s of statuses) row[s] = Number(byGameRows.find((x) => x.game === game && x.s === s)?.n ?? 0);
      return row;
    });
    const overTime = (
      await this.sql.all<{ date: string; match: number; mismatch: number; other: number }>(
        `SELECT COALESCE(date(round_timestamp), date(audited_at)) AS date,
           SUM(outcome_status = 'match') AS match, SUM(outcome_status = 'mismatch') AS mismatch,
           SUM(outcome_status NOT IN ('match','mismatch')) AS other
         FROM rounds ${clause} GROUP BY 1 ORDER BY 1`,
        ...params,
      )
    ).map((r) => ({ date: r.date, match: Number(r.match), mismatch: Number(r.mismatch), other: Number(r.other) }));
    const overall: Record<string, number> = {};
    for (const r of await this.sql.all<{ s: string; n: number }>(`SELECT overall_status AS s, COUNT(*) AS n FROM rounds ${clause} GROUP BY 1`, ...params)) {
      overall[r.s] = Number(r.n);
    }
    return { metrics: m, byGame, overTime, overall };
  }

  async seedSessions(f: { game?: string; limit?: number; offset?: number } = {}): Promise<{ total: number; sessions: SeedSession[] }> {
    const where = "WHERE server_seed IS NOT NULL AND server_seed <> ''" + (f.game ? " AND game = ?" : "");
    const params: Param[] = f.game ? [f.game] : [];
    const total = Number((await this.sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM rounds ${where} GROUP BY game, server_seed, client_seed)`, ...params))?.n ?? 0);
    const rows = await this.sql.all<Record<string, string | number | null>>(
      `SELECT game, server_seed, client_seed, COUNT(*) AS rounds,
           json_group_array(DISTINCT algorithm_version) AS versions,
           MIN(${NUMERIC_NONCE_KEY}) AS nmin, MAX(${NUMERIC_NONCE_KEY}) AS nmax,
           MIN(round_timestamp) AS first_seen, MAX(round_timestamp) AS last_seen,
           SUM(commitment IS NOT NULL) AS commitments, COUNT(DISTINCT commitment) AS distinct_commitments,
           SUM(outcome_status = 'mismatch') AS mismatches,
           json_group_array(DISTINCT evidence_source) AS sources,
           COUNT(*) - COUNT(DISTINCT COALESCE(nonce, '#' || id)) AS nonce_repeats
         FROM rounds ${where}
         GROUP BY game, server_seed, client_seed
         ORDER BY MAX(id) DESC LIMIT ? OFFSET ?`,
      ...params,
      f.limit ?? 50,
      f.offset ?? 0,
    );
    // JSON arrays, not comma-joined text: an evidence source such as "export, page 2" must stay one value
    const split = (v: unknown) => (typeof v === "string" ? (JSON.parse(v) as (string | null)[]).filter((x): x is string => typeof x === "string" && x !== "") : []);
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
          nonceMin: nonceFromKey(r.nmin),
          nonceMax: nonceFromKey(r.nmax),
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
  async createImport(job: ImportJob) {
    await this.sql.run(
      "INSERT INTO imports (id, created_at, format, filename, total, stored, rejected, errors_json, status, processed, duplicates, chunks_done, updated_at, skip_duplicates) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      job.id,
      job.createdAt,
      job.format,
      job.filename,
      job.total,
      0,
      0,
      "[]",
      job.status,
      0,
      0,
      0,
      job.createdAt,
      job.skipDuplicates ? 1 : 0,
    );
  }

  /** The UPDATE that records a job's progress; batched with a chunk's inserts so both commit together. */
  importUpdateStatement(job: ImportJob): Statement {
    return {
      sql: "UPDATE imports SET total=?, stored=?, rejected=?, errors_json=?, status=?, processed=?, duplicates=?, finished_at=?, outcome_counts_json=?, failure=?, chunks_done=?, updated_at=? WHERE id=?",
      args: [
        job.total,
        job.stored,
        job.rejected,
        JSON.stringify(job.errors),
        job.status,
        job.processed,
        job.duplicates,
        job.finishedAt,
        JSON.stringify(job.outcomeCounts),
        job.failure,
        job.chunksDone,
        new Date().toISOString(),
        job.id,
      ],
    };
  }

  async updateImport(job: ImportJob) {
    await this.sql.run(...toArgs(this.importUpdateStatement(job)));
  }

  async listImports(limit = 50): Promise<ImportJob[]> {
    return (await this.sql.all("SELECT * FROM imports ORDER BY created_at DESC LIMIT ?", limit)).map((r) => this.toImport(r));
  }

  async getImport(id: string): Promise<ImportJob | null> {
    const r = await this.sql.get("SELECT * FROM imports WHERE id = ?", id);
    return r ? this.toImport(r) : null;
  }

  private toImport(r: Record<string, unknown>): ImportJob {
    const errors = JSON.parse((r.errors_json as string) || "[]");
    let status = (r.status as ImportJobStatus) ?? "completed";
    const updatedAt = (r.updated_at as string | null) ?? (r.created_at as string);
    // the uploader (a browser tab) went away: nothing will arrive, so say so instead of "running" forever
    if ((status === "running" || status === "paused") && Date.now() - Date.parse(updatedAt) > IMPORT_STALE_MS) status = "interrupted";
    return {
      id: r.id as string,
      status,
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
      chunksDone: Number(r.chunks_done ?? 0),
      skipDuplicates: Number(r.skip_duplicates ?? 1) === 1,
      updatedAt,
    };
  }
}

const toArgs = (s: Statement): [string, ...Param[]] => [s.sql, ...(s.args ?? [])];
