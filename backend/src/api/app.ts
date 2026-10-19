import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { z } from "zod";
import { FairnessDb, type RoundFilter } from "../database/db.js";
import { verifyRound, outcomeKey, APP_VERSION, type VerifyOptions } from "../verification/engine.js";
import { ImportJobs } from "../imports/jobs.js";
import { runIntegrityAudit } from "../auditing/integrity.js";
import { csvLines, toHtml, toJson, toPdf } from "../exports/reports.js";
import { standaloneScript } from "../exports/standalone.js";
import { fetchTransactionEvidence } from "../blockchain/solana.js";
import { hmacSha256Hex, sha256Hex } from "../crypto/hmac.js";
import { buildTranscript, V2_PROTOCOL_LABEL } from "../crypto/transcript.js";
import {
  ALGORITHM_VERSIONS,
  BLACKJACK_VERSION,
  CRASH_VERSION,
  KENO_BOARD,
  KENO_DIFFICULTIES,
  LIMITS,
  MINES_GRID_SIZES,
  type StoredRound,
} from "../../../shared/src/contracts.js";

export interface AppOptions {
  db?: FairnessDb;
  staticDir?: string;
  logger?: boolean;
  /** extra host names accepted in the Host header (besides localhost / 127.0.0.1 / [::1]) */
  allowedHosts?: string[];
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const hostname = (hostHeader: string) => {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
};

export async function buildApp(opts: AppOptions = {}) {
  const db = opts.db ?? new FairnessDb();
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: LIMITS.importBytes + 1024 * 1024 });
  const allowedHosts = new Set([...LOOPBACK_HOSTS, ...(opts.allowedHosts ?? []).map((h) => h.toLowerCase())]);

  // ---------------------------------------------------------------- request guards
  app.addHook("onRequest", async (req, reply) => {
    // S-01: DNS-rebinding protection. A malicious site that rebinds its domain to 127.0.0.1 still sends its own Host.
    const host = req.headers.host ?? "";
    if (!allowedHosts.has(hostname(host))) {
      return reply.code(421).send({ error: "Misdirected request: this local tool only answers to localhost." });
    }
    // S-02: CSRF protection. Browsers send Origin on cross-site requests; state-changing calls must be same-origin.
    const origin = req.headers.origin;
    if (origin && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      let originHost = "";
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        /* malformed origin -> rejected below */
      }
      if (originHost !== host.toLowerCase()) return reply.code(403).send({ error: "Cross-origin requests are not allowed." });
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-opener-policy", "same-origin");
    if (!reply.getHeader("content-security-policy")) {
      reply.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
    }
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    return payload;
  });

  // Never echo internals (stack traces, SQL) and never log request bodies (they contain seeds).
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    // HttpError messages are written by us and safe to show; anything unexpected is masked.
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ msg: "request failed", route: req.routeOptions?.url, err: err.message });
      return reply.code(500).send({ error: "Internal error. The request was not processed; see the server console for details." });
    }
    return reply.code(status).send({ error: err.message });
  });

  const verifyOpts = (mode: "manual" | "import", trace = true): VerifyOptions => ({ commitmentScheme: db.getSettings().commitmentScheme, mode, trace });
  const jobs = new ImportJobs(db, () => verifyOpts("import", false));
  const parse = <S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> => {
    const r = schema.safeParse(data);
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "));
    return r.data;
  };
  const idParam = (req: FastifyRequest) => parse(z.object({ id: z.coerce.number().int().positive() }), req.params).id;

  /**
   * Opens a stored round for display/export: rebuilds anything not stored (trace, notes, comparison
   * rows) from the inputs, checks recomputation reproduces the stored outcome, and reports when
   * today's settings would assess it differently. Stored statuses remain authoritative.
   */
  const hydrate = (r: StoredRound): StoredRound => {
    if (["invalid_input", "unsupported_version"].includes(r.outcomeStatus)) return r;
    const fresh = verifyRound(r.result.inputs, verifyOpts("import", true));
    const reproduced = outcomeKey(r.game, fresh.calculated) === outcomeKey(r.game, r.calculated);
    const differs = fresh.overall !== r.overallStatus || fresh.outcome.status !== r.outcomeStatus || fresh.commitment.status !== r.commitmentStatus;
    const currentAssessment = differs ? { overall: fresh.overall, outcome: fresh.outcome.status, commitment: fresh.commitment.status } : null;
    const needsTrace = r.result.trace.length === 0;
    const result = r.compact
      ? {
          ...fresh,
          // authoritative stored facts
          outcome: r.result.outcome,
          overall: r.overallStatus,
          errors: r.result.errors,
          computedAt: r.result.computedAt,
          appVersion: r.result.appVersion,
          reported: r.recorded,
          calculated: r.calculated,
          commitment: { ...fresh.commitment, status: r.commitmentStatus },
          timing: { ...fresh.timing, status: r.timingStatus },
        }
      : { ...r.result, trace: needsTrace ? fresh.trace : r.result.trace, comparisons: r.result.comparisons.length ? r.result.comparisons : fresh.comparisons };
    return { ...r, result: result as StoredRound["result"], traceRegenerated: needsTrace, reproduced, currentAssessment };
  };

  // ---------------------------------------------------------------- meta
  app.get("/api/health", async () => ({ ok: true, version: APP_VERSION, schema: db.schemaVersion }));

  app.get("/api/meta", async () => ({
    version: APP_VERSION,
    schemaVersion: db.schemaVersion,
    migration: db.migration,
    algorithmVersions: ALGORITHM_VERSIONS,
    crashVersion: CRASH_VERSION,
    blackjackVersion: BLACKJACK_VERSION,
    keno: { difficulties: KENO_DIFFICULTIES, boards: KENO_BOARD, minPicks: 1, maxPicks: 10 },
    mines: { gridSizes: MINES_GRID_SIZES },
    v2ProtocolLabel: V2_PROTOCOL_LABEL,
    limits: LIMITS,
  }));

  // ---------------------------------------------------------------- verification
  app.post("/api/verify", async (req) => {
    const body = parse(z.object({ input: z.unknown(), save: z.boolean().optional() }), req.body ?? {});
    const result = verifyRound(body.input, verifyOpts("manual"));
    const savedId = body.save ? db.insertRound(result) : null;
    return { result, savedId };
  });

  app.post("/api/compare-versions", async (req) => {
    const input = parse(z.record(z.unknown()), req.body ?? {});
    return {
      note: "Exploratory: both versions are shown side by side. Which version applies to a round must come from the round's record - the Lab never selects a version because it matches.",
      results: ALGORITHM_VERSIONS.map((v) => verifyRound({ ...input, algorithmVersion: v }, verifyOpts("manual"))),
    };
  });

  const hmacSchema = z.object({
    key: z.string().max(LIMITS.hmacPartLength),
    keyEncoding: z.enum(["utf8", "hex"]).default("utf8"),
    parts: z
      .array(z.object({ value: z.string().max(LIMITS.hmacPartLength), encoding: z.enum(["utf8", "hex", "uint32be"]).default("utf8") }))
      .max(LIMITS.hmacParts)
      .default([]),
  });
  app.post("/api/tools/hmac", async (req) => {
    const p = parse(hmacSchema, req.body);
    const toBuf = (value: string, enc: string) => {
      if (enc === "hex") {
        if (!/^([0-9a-fA-F]{2})*$/.test(value)) throw new HttpError(400, `"${value.slice(0, 20)}" is not valid hex`);
        return Buffer.from(value, "hex");
      }
      if (enc === "uint32be") {
        const n = Number(value);
        if (!/^\d+$/.test(value) || n > 0xffffffff) throw new HttpError(400, "uint32be value must be 0-4294967295");
        const b = Buffer.alloc(4);
        b.writeUInt32BE(n);
        return b;
      }
      return Buffer.from(value, "utf8");
    };
    const key = toBuf(p.key, p.keyEncoding);
    const parts = p.parts.map((x) => toBuf(x.value, x.encoding));
    return { keyHex: key.toString("hex"), messageHex: Buffer.concat(parts).toString("hex"), hmac: hmacSha256Hex(key, ...parts), sha256OfKey: sha256Hex(key) };
  });

  app.post("/api/tools/transcript", async (req) => {
    const p = parse(z.object({ parts: z.array(z.string().max(LIMITS.hmacPartLength)).max(LIMITS.hmacParts) }), req.body);
    return { hex: buildTranscript(p.parts).toString("hex") };
  });

  // ---------------------------------------------------------------- rounds
  const filterSchema = z.object({
    game: z.string().max(32).optional(),
    status: z.string().max(64).optional(),
    outcome: z.string().max(64).optional(),
    batch: z.string().max(64).optional(),
    q: z.string().max(256).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    ids: z
      .string()
      .max(20000)
      .regex(/^\d+(,\d+)*$/, "ids must be a comma-separated list of record numbers")
      .optional(),
  });
  const toFilter = (q: z.infer<typeof filterSchema>): RoundFilter => ({ ...q, ids: q.ids ? q.ids.split(",").map(Number) : undefined });

  app.get("/api/rounds", async (req) => db.listSummaries(toFilter(parse(filterSchema, req.query))));

  app.get("/api/rounds/:id", async (req) => {
    const r = db.getRound(idParam(req));
    if (!r) throw new HttpError(404, "Not found");
    return hydrate(r);
  });

  app.delete("/api/rounds/:id", async (req) => ({ deleted: db.deleteRound(idParam(req)) }));

  /** Re-runs a stored round. With ?update=1 the record is re-audited (previous result kept in its history). */
  app.post("/api/rounds/:id/reverify", async (req) => {
    const id = idParam(req);
    const { update } = parse(z.object({ update: z.enum(["0", "1"]).optional() }), req.query);
    const r = db.getRound(id);
    if (!r) throw new HttpError(404, "Not found");
    const fresh = verifyRound(r.result.inputs, verifyOpts("import"));
    const reproduced = outcomeKey(r.game, fresh.calculated) === outcomeKey(r.game, r.calculated);
    if (update === "1") db.updateRoundResult(id, fresh);
    return { reproduced, updated: update === "1", fresh };
  });

  /** Bulk re-audit of a filtered set (e.g. after confirming the commitment scheme). */
  app.post("/api/rounds/reverify", async (req) => {
    const f = toFilter(parse(filterSchema, req.body ?? {}));
    const ids = [...db.iterateSummaries(f)].map((r) => r.id);
    let changed = 0;
    let reproduced = 0;
    for (let i = 0; i < ids.length; i += 500) {
      db.db.exec("BEGIN IMMEDIATE");
      try {
        for (const id of ids.slice(i, i + 500)) {
          const r = db.getRound(id)!;
          const fresh = verifyRound(r.result.inputs, verifyOpts("import", false));
          if (outcomeKey(r.game, fresh.calculated) === outcomeKey(r.game, r.calculated)) reproduced++;
          if (fresh.overall !== r.overallStatus || fresh.outcome.status !== r.outcomeStatus || fresh.commitment.status !== r.commitmentStatus) {
            db.updateRoundResult(id, fresh);
            changed++;
          }
        }
        db.db.exec("COMMIT");
      } catch (e) {
        db.db.exec("ROLLBACK");
        throw e;
      }
      await yieldToEventLoop();
    }
    return { rounds: ids.length, reproduced, statusChanged: changed };
  });

  app.get("/api/rounds/:id/script", async (req, reply) => {
    const r = db.getRound(idParam(req));
    if (!r) throw new HttpError(404, "Not found");
    reply.header("content-disposition", `attachment; filename="round-${r.id}.mjs"`);
    return reply.type("text/javascript; charset=utf-8").send(standaloneScript(r));
  });

  // ---------------------------------------------------------------- imports
  app.post("/api/import", async (req) => {
    const body = parse(
      z.object({
        text: z.string().min(1, "No data supplied").max(LIMITS.importBytes, `Import is larger than ${LIMITS.importBytes / 1024 / 1024} MB; split the file`),
        format: z.enum(["csv", "json", "jsonl", "auto"]).default("auto"),
        filename: z.string().max(LIMITS.textField).optional().nullable(),
        skipDuplicates: z.boolean().default(true),
      }),
      req.body ?? {},
    );
    const { wait } = parse(z.object({ wait: z.enum(["0", "1"]).optional() }), req.query);
    const job = jobs.start(body.text, { format: body.format, filename: body.filename, skipDuplicates: body.skipDuplicates });
    if (wait === "1") return { job: await jobs.wait(job.id) };
    return { job };
  });

  app.get("/api/import/jobs/:id", async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, "Unknown import");
    return job;
  });

  app.post("/api/import/jobs/:id/:action", async (req) => {
    const { id, action } = parse(z.object({ id: z.string().uuid(), action: z.enum(["pause", "resume", "cancel"]) }), req.params);
    const ok = action === "pause" ? jobs.pause(id) : action === "resume" ? jobs.resume(id) : jobs.cancel(id);
    if (!ok) throw new HttpError(409, `Cannot ${action} this import in its current state`);
    return jobs.get(id);
  });

  app.get("/api/imports", async () => db.listImports());

  // ---------------------------------------------------------------- analytics
  // Derived views are cached until the data changes (db.revision) - repeated dashboard visits are free.
  const cache = new Map<string, { rev: number; value: unknown }>();
  const cached = <T>(key: string, compute: () => T): T => {
    const hit = cache.get(key);
    if (hit && hit.rev === db.revision) return hit.value as T;
    const value = compute();
    if (cache.size > 200) cache.clear();
    cache.set(key, { rev: db.revision, value });
    return value;
  };
  app.get("/api/stats", async (req) => {
    const f = toFilter(parse(filterSchema, req.query));
    return cached(`stats:${JSON.stringify(f)}`, () => db.stats(f));
  });
  app.get("/api/integrity", async () => cached("integrity", () => runIntegrityAudit(db.db)));
  app.get("/api/sessions", async (req) =>
    db.seedSessions(parse(z.object({ game: z.string().max(32).optional(), limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional() }), req.query)),
  );

  // ---------------------------------------------------------------- exports
  app.get("/api/export", async (req, reply: FastifyReply) => {
    const q = parse(filterSchema.extend({ format: z.enum(["csv", "json", "html", "pdf"]) }), req.query);
    const f = toFilter(q);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    reply.header("content-disposition", `attachment; filename="solpump-fairness-report-${stamp}.${q.format}"`);
    if (q.format === "csv") {
      // streamed: memory stays flat regardless of size
      return reply.type("text/csv; charset=utf-8").send(Readable.from(csvLines(db.iterateSummaries({ ...f, limit: undefined, offset: undefined }))));
    }
    const total = db.countRounds(f);
    if ((q.format === "html" || q.format === "pdf") && total > LIMITS.htmlPdfExportRounds) {
      throw new HttpError(413, `${total} records selected; HTML/PDF reports are limited to ${LIMITS.htmlPdfExportRounds}. Filter by game, status or import batch, or use CSV/JSON.`);
    }
    const withTraces = total <= LIMITS.jsonExportTraceRounds;
    const rounds = [...db.iterateRounds({ ...f, limit: undefined, offset: undefined })].map((r) => (withTraces ? hydrate(r) : r));
    if (q.format === "json") return reply.type("application/json; charset=utf-8").send(toJson(rounds, withTraces));
    if (q.format === "html") {
      // the report is static: no scripts may run in it even if opened from this origin
      reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      return reply.type("text/html; charset=utf-8").send(toHtml(rounds));
    }
    return reply.type("application/pdf").send(await toPdf(rounds));
  });

  // ---------------------------------------------------------------- settings / maintenance
  app.get("/api/settings", async () => db.getSettings());
  app.put("/api/settings", async (req) => {
    const p = parse(
      z.object({
        commitmentScheme: z.enum(["unconfirmed", "sha256_utf8_hex"]).optional(),
        solanaRpcUrl: z
          .string()
          .max(512)
          .url()
          .refine((u) => /^https?:$/.test(new URL(u).protocol), "RPC URL must use http or https")
          .optional(),
      }),
      req.body,
    );
    return db.setSettings(p);
  });

  app.post("/api/backup", async () => {
    const file = db.backup("manual");
    return { file, bytes: statSync(file).size };
  });

  app.post("/api/chain/tx", async (req) => {
    const p = parse(z.object({ signature: z.string().max(128), needles: z.array(z.string().max(1024)).max(20).default([]) }), req.body);
    try {
      return await fetchTransactionEvidence(db.getSettings().solanaRpcUrl, p.signature.trim(), p.needles);
    } catch (e) {
      throw new HttpError(502, (e as Error).message);
    }
  });

  if (opts.staticDir && existsSync(opts.staticDir)) {
    await app.register(fastifyStatic, { root: opts.staticDir, prefix: "/", index: ["index.html"] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  return { app, db, jobs };
}
