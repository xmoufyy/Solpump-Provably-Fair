import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { GAMES, LIMITS, type ImportJob } from "../../../shared/src/contracts.js";
import type { FairnessDb } from "../database/db.js";
import { fingerprintOf } from "../database/db.js";
import { verifyRound, type VerifyOptions } from "../verification/engine.js";
import { normalizeRow, openImport, type ImportFormat, type RawRow } from "./parse.js";

export interface StartImportOptions {
  format: ImportFormat;
  filename?: string | null;
  /** skip rows whose fingerprint already exists (default true) - makes re-importing a file idempotent */
  skipDuplicates?: boolean;
  chunkSize?: number;
}

interface Control {
  job: ImportJob;
  paused: boolean;
  cancelled: boolean;
  resume: (() => void) | null;
  done: Promise<ImportJob>;
}

/**
 * Background, chunked, cancellable import.
 *
 * - Parsing is structural only (fast); normalisation + verification + insertion run per chunk.
 * - Each chunk is one SQLite transaction: a crash or failure can never leave a half-written row,
 *   and every committed row is a complete, verified record tagged with the import id.
 * - Between chunks the event loop is released so the UI and API stay responsive.
 * - Verification during import skips trace generation; traces are regenerated on demand
 *   (every algorithm is deterministic, and the detail view checks the recomputation matches).
 */
export class ImportJobs {
  private controls = new Map<string, Control>();

  constructor(
    private readonly db: FairnessDb,
    private readonly verifyOptions: () => VerifyOptions,
  ) {}

  start(text: string, opts: StartImportOptions): ImportJob {
    const { format, rows, total } = openImport(text, opts.format);
    const job: ImportJob = {
      id: randomUUID(),
      status: "running",
      format,
      filename: opts.filename ?? null,
      total,
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
    };
    this.db.createImport(job);
    const control: Control = { job, paused: false, cancelled: false, resume: null, done: Promise.resolve(job) };
    control.done = this.run(control, rows, opts);
    this.controls.set(job.id, control);
    return { ...job };
  }

  private async run(c: Control, source: Iterable<RawRow>, opts: StartImportOptions): Promise<ImportJob> {
    const rows = source[Symbol.iterator]();
    const { job } = c;
    // Time-sliced chunks: commit + yield after SLICE_MS of work or `maxRows` rows, whichever comes first.
    // Measured (20k rows): fixed 250-row chunks 4.8 s, 500 3.8 s, 2000 3.4 s - but 2000 rows can hold the
    // event loop for ~350 ms. Time slicing keeps the larger-chunk throughput with a bounded stall.
    const maxRows = opts.chunkSize ?? 2000;
    const SLICE_MS = 100;
    const skipDuplicates = opts.skipDuplicates ?? true;
    const vopts: VerifyOptions = { ...this.verifyOptions(), mode: "import", trace: false };
    const reject = (line: number, error: string) => {
      job.rejected++;
      if (job.errors.length < LIMITS.importErrorsKept) job.errors.push({ line, error });
      else job.errorsTruncated = true;
    };
    try {
      let next = rows.next();
      while (!next.done) {
        if (c.paused) {
          job.status = "paused";
          this.db.updateImport(job);
          await new Promise<void>((res) => (c.resume = res));
          job.status = "running";
        }
        if (c.cancelled) break;
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
          const sliceStart = performance.now();
          for (let n = 0; !next.done && n < maxRows && performance.now() - sliceStart < SLICE_MS; n++, next = rows.next()) {
            const row = normalizeRow(next.value);
            job.processed++;
            if (!row.input) {
              reject(row.line, row.error ?? "Unparseable row");
              continue;
            }
            if (!(GAMES as readonly string[]).includes(String(row.input.game))) {
              reject(row.line, `Unknown game "${String(row.input.game)}" (expected crash, blackjack, keno or mines)`);
              continue;
            }
            if (skipDuplicates) {
              const existing = this.db.findByFingerprint(fingerprintOf(row.input));
              if (existing !== null) {
                job.duplicates++;
                continue;
              }
            }
            const result = verifyRound(row.input, vopts);
            this.db.insertRound(result, job.id, false);
            job.stored++;
            job.outcomeCounts[result.outcome.status] = (job.outcomeCounts[result.outcome.status] ?? 0) + 1;
          }
          this.db.db.exec("COMMIT");
        } catch (e) {
          this.db.db.exec("ROLLBACK");
          throw e;
        }
        this.db.updateImport(job);
        await yieldToEventLoop();
      }
      if (!c.cancelled) job.total = job.processed; // exact once fully read
      job.status = c.cancelled ? "cancelled" : "completed";
    } catch (e) {
      job.status = "failed";
      job.failure = `Import stopped: ${(e as Error).message}. Rows committed before the failure are kept (each is complete).`;
    }
    job.finishedAt = new Date().toISOString();
    this.db.updateImport(job);
    return { ...job };
  }

  get(id: string): ImportJob | null {
    const c = this.controls.get(id);
    return c ? { ...c.job, errors: [...c.job.errors] } : this.db.getImport(id);
  }

  wait(id: string): Promise<ImportJob> | null {
    return this.controls.get(id)?.done ?? null;
  }

  pause(id: string) {
    const c = this.controls.get(id);
    if (!c || c.job.status !== "running") return false;
    c.paused = true;
    return true;
  }

  resume(id: string) {
    const c = this.controls.get(id);
    if (!c || !c.paused) return false;
    c.paused = false;
    c.resume?.();
    c.resume = null;
    return true;
  }

  cancel(id: string) {
    const c = this.controls.get(id);
    if (!c || !["running", "paused"].includes(c.job.status)) return false;
    c.cancelled = true;
    if (c.paused) this.resume(id);
    return true;
  }
}
