import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VerificationResult } from "../verification/engine.js";
import type { CommitmentScheme } from "../crypto/commitments.js";

const DEFAULT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/fairness-lab.db");

export interface Settings {
  commitmentScheme: CommitmentScheme;
  solanaRpcUrl: string;
}
const DEFAULT_SETTINGS: Settings = {
  commitmentScheme: "unconfirmed",
  solanaRpcUrl: "https://api.mainnet-beta.solana.com",
};

export interface StoredRound {
  id: number;
  roundId: string | null;
  game: string;
  algorithmVersion: string | null;
  nonce: string | null;
  serverSeed: string | null;
  clientSeed: string | null;
  outcomeStatus: string;
  commitmentStatus: string;
  timingStatus: string;
  overallStatus: string;
  evidenceSource: string | null;
  roundTimestamp: string | null;
  auditedAt: string;
  importBatchId: string | null;
  recorded: unknown;
  calculated: unknown;
  result: VerificationResult;
}

export class FairnessDb {
  db: DatabaseSync;

  constructor(path = process.env.SFL_DB_PATH ?? DEFAULT_PATH) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id TEXT,
        game TEXT NOT NULL,
        algorithm_version TEXT,
        nonce TEXT,
        server_seed TEXT,
        client_seed TEXT,
        outcome_status TEXT NOT NULL,
        commitment_status TEXT NOT NULL,
        timing_status TEXT NOT NULL,
        overall_status TEXT NOT NULL,
        evidence_source TEXT,
        round_timestamp TEXT,
        audited_at TEXT NOT NULL,
        import_batch_id TEXT,
        inputs_json TEXT NOT NULL,
        recorded_json TEXT,
        calculated_json TEXT,
        result_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rounds_game ON rounds(game);
      CREATE INDEX IF NOT EXISTS idx_rounds_round_id ON rounds(round_id);
      CREATE TABLE IF NOT EXISTS imports (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        format TEXT NOT NULL,
        filename TEXT,
        total INTEGER NOT NULL,
        stored INTEGER NOT NULL,
        rejected INTEGER NOT NULL,
        errors_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  getSettings(): Settings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) s[r.key] = JSON.parse(r.value);
    return s as unknown as Settings;
  }

  setSettings(patch: Partial<Settings>) {
    const stmt = this.db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) stmt.run(k, JSON.stringify(v));
    return this.getSettings();
  }

  insertRound(result: VerificationResult, importBatchId: string | null = null): number {
    const inputs = (result.inputs ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : v == null ? null : String(v));
    const info = this.db
      .prepare(
        `INSERT INTO rounds (round_id, game, algorithm_version, nonce, server_seed, client_seed, outcome_status, commitment_status,
          timing_status, overall_status, evidence_source, round_timestamp, audited_at, import_batch_id, inputs_json, recorded_json,
          calculated_json, result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        result.reported ? JSON.stringify(result.reported) : null,
        result.calculated ? JSON.stringify(result.calculated) : null,
        JSON.stringify(result),
      );
    return Number(info.lastInsertRowid);
  }

  private mapRow(r: Record<string, unknown>): StoredRound {
    return {
      id: r.id as number,
      roundId: r.round_id as string | null,
      game: r.game as string,
      algorithmVersion: r.algorithm_version as string | null,
      nonce: r.nonce as string | null,
      serverSeed: r.server_seed as string | null,
      clientSeed: r.client_seed as string | null,
      outcomeStatus: r.outcome_status as string,
      commitmentStatus: r.commitment_status as string,
      timingStatus: r.timing_status as string,
      overallStatus: r.overall_status as string,
      evidenceSource: r.evidence_source as string | null,
      roundTimestamp: r.round_timestamp as string | null,
      auditedAt: r.audited_at as string,
      importBatchId: r.import_batch_id as string | null,
      recorded: r.recorded_json ? JSON.parse(r.recorded_json as string) : null,
      calculated: r.calculated_json ? JSON.parse(r.calculated_json as string) : null,
      result: JSON.parse(r.result_json as string),
    };
  }

  listRounds(filter: { game?: string; status?: string; q?: string; ids?: number[]; limit?: number; offset?: number } = {}) {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.game) (where.push("game = ?"), params.push(filter.game));
    if (filter.status) (where.push("overall_status = ?"), params.push(filter.status));
    if (filter.q) {
      where.push("(round_id LIKE ? OR server_seed LIKE ? OR client_seed LIKE ? OR nonce LIKE ? OR evidence_source LIKE ?)");
      const like = `%${filter.q}%`;
      params.push(like, like, like, like, like);
    }
    if (filter.ids?.length) (where.push(`id IN (${filter.ids.map(() => "?").join(",")})`), params.push(...filter.ids));
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM rounds ${clause}`).get(...params) as { n: number }).n;
    const limit = filter.limit ?? 100000;
    const offset = filter.offset ?? 0;
    const rows = this.db.prepare(`SELECT * FROM rounds ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { total, rounds: (rows as Record<string, unknown>[]).map((r) => this.mapRow(r)) };
  }

  getRound(id: number): StoredRound | null {
    const r = this.db.prepare("SELECT * FROM rounds WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.mapRow(r) : null;
  }

  deleteRound(id: number) {
    return Number(this.db.prepare("DELETE FROM rounds WHERE id = ?").run(id).changes);
  }

  recordImport(row: { id: string; format: string; filename: string | null; total: number; stored: number; rejected: number; errors: unknown[] }) {
    this.db
      .prepare("INSERT INTO imports (id, created_at, format, filename, total, stored, rejected, errors_json) VALUES (?,?,?,?,?,?,?,?)")
      .run(row.id, new Date().toISOString(), row.format, row.filename, row.total, row.stored, row.rejected, JSON.stringify(row.errors));
  }

  listImports() {
    return (this.db.prepare("SELECT * FROM imports ORDER BY created_at DESC").all() as Record<string, unknown>[]).map((r) => ({
      ...r,
      errors: JSON.parse(r.errors_json as string),
      errors_json: undefined,
    }));
  }
}
