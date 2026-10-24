import { randomUUID } from "node:crypto";
import { GAMES, LIMITS, type ImportJob } from "../../../shared/src/contracts.js";
import type { ConcreteFormat, ImportFormat } from "../../../shared/src/imports.js";
import type { FairnessDb } from "../database/db.js";
import { fingerprintOf } from "../database/db.js";
import type { Statement } from "../database/sql.js";
import { verifyRound, type VerifyOptions } from "../verification/engine.js";
import { detectFormat, normalizeRow, openImport } from "./parse.js";

export class ImportError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CreateImportOptions {
  format: ConcreteFormat;
  filename?: string | null;
  /** number of records the uploader will send (for progress) */
  total: number;
  /** skip rows whose fingerprint already exists (default true) - makes re-importing a file idempotent */
  skipDuplicates?: boolean;
}

/**
 * Chunked, stateless imports. The uploader (the browser, or `importText` for one-shot imports) sends a
 * file as numbered chunks; nothing runs in the background, so this works the same on a local server
 * and on serverless hosting where no process outlives a request.
 *
 * - A chunk's rows and the job's progress are written in ONE atomic batch: a failure can never leave a
 *   half-written chunk or counters that disagree with the stored rows.
 * - Every insert is conditional on the job having advanced to this chunk's sequence number inside that
 *   same batch, so a retried or concurrently repeated chunk can never store its rows twice.
 * - Verification during import skips trace generation; traces are regenerated on demand
 *   (every algorithm is deterministic, and the detail view checks the recomputation matches).
 * - Pause / resume / cancel: the uploader stops or continues sending; the job status records it.
 *   A job that stops receiving chunks is reported as interrupted (see IMPORT_STALE_MS).
 */
export class Imports {
  constructor(
    private readonly db: FairnessDb,
    private readonly verifyOptions: () => Promise<VerifyOptions>,
  ) {}

  async create(opts: CreateImportOptions): Promise<ImportJob> {
    const job: ImportJob = {
      id: randomUUID(),
      status: "running",
      format: opts.format,
      filename: opts.filename ?? null,
      total: opts.total,
      processed: 0,
      stored: 0,
      rejected: 0,
      duplicates: 0,
      outcomeCounts: {},
      errors: [],
      errorsTruncated: false,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      failure: null,
      chunksDone: 0,
      skipDuplicates: opts.skipDuplicates ?? true,
      updatedAt: new Date().toISOString(),
    };
    await this.db.createImport(job);
    return job;
  }

  get(id: string): Promise<ImportJob | null> {
    return this.db.getImport(id);
  }

  private async require(id: string): Promise<ImportJob> {
    const job = await this.db.getImport(id);
    if (!job) throw new ImportError(404, "Unknown import");
    return job;
  }

  /**
   * Verifies and stores one chunk. `seq` must be the job's next chunk number; a chunk that was already
   * committed (a retry) is acknowledged without being applied again. `lineOffset` maps the chunk's line
   * numbers back to the original file.
   */
  async chunk(id: string, seq: number, text: string, lineOffset = 0): Promise<ImportJob> {
    const job = await this.require(id);
    if (seq < job.chunksDone) return job; // already committed: idempotent retry
    if (seq > job.chunksDone) throw new ImportError(409, `Chunk ${seq} arrived before chunk ${job.chunksDone}; send chunks in order.`);
    // A chunk already in flight when the user paused is still applied; the job stays paused until resumed.
    if (job.status !== "running" && job.status !== "paused") throw new ImportError(409, `This import is ${job.status}; no further chunks are accepted.`);

    const vopts: VerifyOptions = { ...(await this.verifyOptions()), mode: "import", trace: false };
    const reject = (line: number, error: string) => {
      job.rejected++;
      if (job.errors.length < LIMITS.importErrorsKept) job.errors.push({ line, error });
      else job.errorsTruncated = true;
    };
    const verified: { fingerprint: string; insert: Statement; status: string }[] = [];
    for (const raw of openImport(text, job.format as ImportFormat).rows) {
      const row = normalizeRow(raw);
      const line = row.line > 0 ? row.line + lineOffset : row.line;
      job.processed++;
      if (!row.input) {
        reject(line, row.error ?? "Unparseable row");
        continue;
      }
      if (!(GAMES as readonly string[]).includes(String(row.input.game))) {
        reject(line, `Unknown game "${String(row.input.game)}" (expected crash, blackjack, keno or mines)`);
        continue;
      }
      const result = verifyRound(row.input, vopts);
      verified.push({ fingerprint: fingerprintOf(row.input), insert: this.db.insertStatement(result, job.id, false), status: result.outcome.status });
    }

    const existing = job.skipDuplicates ? await this.db.existingFingerprints(verified.map((v) => v.fingerprint)) : new Set<string>();
    const inserts: Statement[] = [];
    for (const v of verified) {
      if (job.skipDuplicates) {
        if (existing.has(v.fingerprint)) {
          job.duplicates++;
          continue;
        }
        existing.add(v.fingerprint); // a duplicate later in the same chunk is skipped too
      }
      inserts.push(onlyIfAdvanced(v.insert, job.id, seq + 1));
      job.stored++;
      job.outcomeCounts[v.status as keyof ImportJob["outcomeCounts"]] = (job.outcomeCounts[v.status as keyof ImportJob["outcomeCounts"]] ?? 0) + 1;
    }
    job.chunksDone = seq + 1;
    const advance = this.db.importUpdateStatement(job);
    const [moved] = await this.db.sql.batch([{ sql: `${advance.sql} AND chunks_done = ?`, args: [...(advance.args ?? []), seq] }, ...inserts]);
    if (moved.changes === 0) return this.require(id); // another request committed this chunk first; nothing was applied here
    return job;
  }

  /** All chunks sent: the import is complete. */
  async finish(id: string): Promise<ImportJob> {
    const job = await this.require(id);
    if (job.status === "completed") return job;
    if (job.status !== "running" && job.status !== "paused") throw new ImportError(409, `This import is ${job.status}.`);
    job.total = job.processed; // exact once fully read
    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    await this.db.updateImport(job);
    return job;
  }

  async control(id: string, action: "pause" | "resume" | "cancel"): Promise<ImportJob> {
    const job = await this.require(id);
    const allowed = { pause: ["running"], resume: ["paused", "interrupted"], cancel: ["running", "paused", "interrupted"] }[action];
    if (!allowed.includes(job.status)) throw new ImportError(409, `Cannot ${action} this import in its current state`);
    job.status = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
    if (action === "cancel") job.finishedAt = new Date().toISOString();
    await this.db.updateImport(job);
    return job;
  }

  /** One-shot import of a whole text (small files, the API's `text` form, tests). */
  async importText(text: string, opts: { format: ImportFormat; filename?: string | null; skipDuplicates?: boolean }): Promise<ImportJob> {
    const source = openImport(text, opts.format);
    const job = await this.create({ format: opts.format === "auto" ? detectFormat(text) : opts.format, filename: opts.filename, total: source.total, skipDuplicates: opts.skipDuplicates });
    try {
      await this.chunk(job.id, 0, text);
      return await this.finish(job.id);
    } catch (e) {
      if (e instanceof ImportError) throw e;
      const failed = { ...(await this.require(job.id)), status: "failed" as const, failure: `Import stopped: ${(e as Error).message}. Nothing from the failed part was stored.`, finishedAt: new Date().toISOString() };
      await this.db.updateImport(failed);
      return failed;
    }
  }
}

/** Rewrites an INSERT ... VALUES (...) so it applies only if the job reached `chunksDone` in the same batch. */
function onlyIfAdvanced(insert: Statement, jobId: string, chunksDone: number): Statement {
  const at = insert.sql.lastIndexOf("VALUES (");
  const values = insert.sql.slice(at + "VALUES (".length, insert.sql.lastIndexOf(")"));
  return {
    sql: `${insert.sql.slice(0, at)}SELECT ${values} WHERE EXISTS (SELECT 1 FROM imports WHERE id = ? AND chunks_done = ?)`,
    args: [...(insert.args ?? []), jobId, chunksDone],
  };
}
