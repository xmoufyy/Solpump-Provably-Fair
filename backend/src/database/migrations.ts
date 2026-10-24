import { createHash } from "node:crypto";
import type { Sql, Statement } from "./sql.js";

/**
 * Schema history
 *  v0 - Fairness Lab 1.0 (no version marker). Created here with IF NOT EXISTS so new and old
 *       databases follow exactly the same migration path.
 *  v1 - Fairness Lab 2.0: fingerprints, re-audit history, import job state, commitment column,
 *       query indexes, 'commitment_mismatch' final assessment.
 *  v2 - chunked imports (serverless-safe): chunk sequence, last activity, duplicate policy per job.
 *
 * Each migration returns its statements; they run in ONE atomic batch together with the
 * user_version bump, so a migration either fully applies or leaves the database untouched.
 * Rollback: every migration has a tested `down`. A local file backup is also written (VACUUM INTO)
 * before migrating any database that contains data.
 */
export const V0_SCHEMA = `
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
`;

export interface Migration {
  version: number;
  description: string;
  up(db: Sql): Promise<Statement[]>;
  down(db: Sql): Promise<Statement[]>;
}

/** Same canonicalisation as FairnessDb.fingerprintOf (duplicated to keep migrations frozen in time). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
function fingerprint(inputs: Record<string, unknown>) {
  const core: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) if (!["source", "timestamp", "txSignature"].includes(k) && v !== null && v !== "") core[k] = v;
  return createHash("sha256").update(canonical(core)).digest("hex");
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "v2.0: fingerprints, re-audit history, import jobs, commitment column, indexes, commitment_mismatch",
    async up(db) {
      const statements = sqlStatements(`
        ALTER TABLE rounds ADD COLUMN fingerprint TEXT;
        ALTER TABLE rounds ADD COLUMN previous_audits_json TEXT;
        ALTER TABLE rounds ADD COLUMN trace_stored INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE rounds ADD COLUMN commitment TEXT;
        ALTER TABLE imports ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
        ALTER TABLE imports ADD COLUMN processed INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE imports ADD COLUMN duplicates INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE imports ADD COLUMN finished_at TEXT;
        ALTER TABLE imports ADD COLUMN outcome_counts_json TEXT;
        ALTER TABLE imports ADD COLUMN failure TEXT;
        UPDATE imports SET processed = total, finished_at = created_at;
      `);
      // backfill fingerprint + commitment from the stored inputs
      for (const row of await db.all<{ id: number; inputs_json: string }>("SELECT id, inputs_json FROM rounds")) {
        const inputs = JSON.parse(row.inputs_json) as Record<string, unknown>;
        const c = typeof inputs.commitment === "string" && inputs.commitment ? inputs.commitment.trim().toLowerCase() : null;
        statements.push({ sql: "UPDATE rounds SET fingerprint = ?, commitment = ? WHERE id = ?", args: [fingerprint(inputs), c, row.id] });
      }
      // v1 reported a commitment mismatch on a matching outcome as plain "mismatch"
      statements.push(
        ...sqlStatements(`
        UPDATE rounds SET overall_status = 'commitment_mismatch',
          result_json = json_set(result_json, '$.overall', 'commitment_mismatch')
        WHERE overall_status = 'mismatch' AND outcome_status <> 'mismatch' AND commitment_status = 'mismatch';
        CREATE INDEX idx_rounds_overall ON rounds(overall_status);
        CREATE INDEX idx_rounds_outcome ON rounds(outcome_status);
        CREATE INDEX idx_rounds_batch ON rounds(import_batch_id);
        CREATE INDEX idx_rounds_fingerprint ON rounds(fingerprint);
        CREATE INDEX idx_rounds_seed_ctx ON rounds(game, server_seed, client_seed, nonce);
        CREATE INDEX idx_rounds_commitment ON rounds(commitment);
        CREATE INDEX idx_imports_created ON imports(created_at);
        -- redundant: idx_rounds_seed_ctx starts with game (one fewer index to maintain per insert)
        DROP INDEX IF EXISTS idx_rounds_game;
      `),
      );
      return statements;
    },
    async down() {
      return sqlStatements(`
        DROP INDEX IF EXISTS idx_rounds_overall;
        DROP INDEX IF EXISTS idx_rounds_outcome;
        DROP INDEX IF EXISTS idx_rounds_batch;
        DROP INDEX IF EXISTS idx_rounds_fingerprint;
        DROP INDEX IF EXISTS idx_rounds_seed_ctx;
        DROP INDEX IF EXISTS idx_rounds_commitment;
        DROP INDEX IF EXISTS idx_imports_created;
        CREATE INDEX IF NOT EXISTS idx_rounds_game ON rounds(game);
        UPDATE rounds SET overall_status = 'mismatch', result_json = json_set(result_json, '$.overall', 'mismatch')
          WHERE overall_status = 'commitment_mismatch';
        ALTER TABLE rounds DROP COLUMN fingerprint;
        ALTER TABLE rounds DROP COLUMN previous_audits_json;
        ALTER TABLE rounds DROP COLUMN trace_stored;
        ALTER TABLE rounds DROP COLUMN commitment;
        ALTER TABLE imports DROP COLUMN status;
        ALTER TABLE imports DROP COLUMN processed;
        ALTER TABLE imports DROP COLUMN duplicates;
        ALTER TABLE imports DROP COLUMN finished_at;
        ALTER TABLE imports DROP COLUMN outcome_counts_json;
        ALTER TABLE imports DROP COLUMN failure;
      `);
    },
  },
  {
    version: 2,
    description: "chunked imports: chunk sequence for idempotent uploads, last activity, duplicate policy",
    async up() {
      return sqlStatements(`
        ALTER TABLE imports ADD COLUMN chunks_done INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE imports ADD COLUMN updated_at TEXT;
        ALTER TABLE imports ADD COLUMN skip_duplicates INTEGER NOT NULL DEFAULT 1;
        UPDATE imports SET updated_at = COALESCE(finished_at, created_at);
      `);
    },
    async down() {
      return sqlStatements(`
        ALTER TABLE imports DROP COLUMN chunks_done;
        ALTER TABLE imports DROP COLUMN updated_at;
        ALTER TABLE imports DROP COLUMN skip_duplicates;
      `);
    },
  },
];

/** Splits a migration script into single statements (the scripts contain no semicolons inside literals). */
export function sqlStatements(script: string): Statement[] {
  return script
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((sql) => ({ sql }));
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
