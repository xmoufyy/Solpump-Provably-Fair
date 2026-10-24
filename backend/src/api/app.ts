import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { z } from "zod";
import { FairnessDb, type RoundFilter } from "../database/db.js";
import type { Statement } from "../database/sql.js";
import { verifyRound, outcomeKey, APP_VERSION, type VerifyOptions } from "../verification/engine.js";
import { boundedArray } from "../verification/schemas.js";
import { ImportError, Imports } from "../imports/jobs.js";
import { runIntegrityAudit } from "../auditing/integrity.js";
import { csvLines, toHtml, toJson, toPdf } from "../exports/reports.js";
import { standaloneScript } from "../exports/standalone.js";
import { fetchTransactionEvidence } from "../blockchain/solana.js";
import { hmacSha256Hex, sha256Hex } from "../crypto/hmac.js";
import { buildTranscript, V2_PROTOCOL_LABEL } from "../crypto/transcript.js";
import {
  authConfigFromEnv,
  issueSession,
  LoginThrottle,
  passwordMatches,
  readCookie,
  SESSION_COOKIE,
  SESSION_SECONDS,
  sessionCookie,
  validSession,
  type AuthConfig,
} from "./auth.js";
import {
  ALGORITHM_VERSIONS,
  BLACKJACK_VERSION,
  CRASH_VERSION,
  KENO_BOARD,
  KENO_DIFFICULTIES,
  LIMITS,
  MINES_GRID_SIZES,
  type CommitmentScheme,
  type CommitmentStatus,
  type StoredRound,
} from "../../../shared/src/contracts.js";

export interface AppOptions {
  db?: FairnessDb;
  staticDir?: string;
  logger?: boolean;
  /** extra host names accepted in the Host header (besides localhost / 127.0.0.1 / [::1]) */
  allowedHosts?: string[];
  /** login settings; defaults to the environment (SFL_PASSWORD, SFL_SESSION_SECRET, VERCEL) */
  auth?: AuthConfig;
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

/** The deployment's own domains on Vercel (set by the platform), plus any custom domains in SFL_ALLOWED_HOSTS. */
export function hostedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL, ...(env.SFL_ALLOWED_HOSTS ?? "").split(",")]
    .map((h) => (h ?? "").trim().toLowerCase())
    .filter(Boolean);
}

/** Routes that answer without a session: the health check and the login itself. */
const PUBLIC_API = new Set(["/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/logout"]);

export async function buildApp(opts: AppOptions = {}) {
  const db = opts.db ?? (await FairnessDb.open());
  const auth = opts.auth ?? authConfigFromEnv();
  const throttle = new LoginThrottle();
  // Only imports carry large bodies; every other route is held to a few MB (the HMAC inspector's largest legal
  // request is ~2.2 MB), so an oversized body is refused before it is parsed or validated.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: LIMITS.requestBytes, trustProxy: auth.hosted });
  const allowedHosts = new Set([...LOOPBACK_HOSTS, ...(opts.allowedHosts ?? []).map((h) => h.toLowerCase()), ...(auth.hosted ? hostedHosts() : [])]);
  const path = (req: FastifyRequest) => req.url.split("?")[0];

  // ---------------------------------------------------------------- request guards
  app.addHook("onRequest", async (req, reply) => {
    // S-01: DNS-rebinding protection. A malicious site that rebinds its domain to 127.0.0.1 still sends its own Host.
    const host = req.headers.host ?? "";
    if (!allowedHosts.has(hostname(host))) {
      return reply.code(421).send({ error: "Misdirected request: this host name is not one this Fairness Lab answers to." });
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
    // Login: every data route needs a session when a password is configured. A hosted deployment without a
    // password is closed rather than open.
    const p = path(req);
    if (!p.startsWith("/api/") || PUBLIC_API.has(p)) return;
    if (auth.password === null) {
      if (auth.hosted) return reply.code(503).send({ error: "This hosted Fairness Lab has no password configured. Set SFL_PASSWORD in the deployment's environment variables, then redeploy." });
      return;
    }
    if (!validSession(auth, readCookie(req.headers.cookie, SESSION_COOKIE))) return reply.code(401).send({ error: "Sign in required." });
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
    // HttpError / ImportError messages are written by us and safe to show; anything unexpected is masked.
    if (err instanceof HttpError || err instanceof ImportError) return reply.code(err.statusCode).send({ error: err.message });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ msg: "request failed", route: req.routeOptions?.url, err: err.message });
      return reply.code(500).send({ error: "Internal error. The request was not processed; see the server log for details." });
    }
    return reply.code(status).send({ error: err.message });
  });

  const scheme = async () => (await db.getSettings()).commitmentScheme;
  const verifyOpts = (commitmentScheme: CommitmentScheme, mode: "manual" | "import", trace = true): VerifyOptions => ({ commitmentScheme, mode, trace });
  const imports = new Imports(db, async () => verifyOpts(await scheme(), "import", false));
  const parse = <S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> => {
    const r = schema.safeParse(data);
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "));
    return r.data;
  };
  /**
   * A record is re-audited under the mode it was created with: a manual entry without a reported outcome is a
   * pure reconstruction, while an imported record claims to be historical, so a missing outcome is a gap.
   * Re-auditing everything as "import" turned every saved manual reconstruction into "missing comparison".
   */
  const auditMode = (r: { importBatchId: string | null }) => (r.importBatchId ? "import" : "manual");
  /** The commitment scheme a stored commitment status was produced under (null: no commitment was supplied). */
  const schemeBehind = (s: CommitmentStatus): CommitmentScheme | null =>
    s === "verified" || s === "mismatch" ? "sha256_utf8_hex" : s === "scheme_unconfirmed" ? "unconfirmed" : null;
  const idParam = (req: FastifyRequest) => parse(z.object({ id: z.coerce.number().int().positive() }), req.params).id;

  /**
   * Opens a stored round for display/export: rebuilds anything not stored (trace, notes, comparison
   * rows) from the inputs, checks recomputation reproduces the stored outcome, and reports when
   * today's settings (`current`) would assess it differently. Stored statuses remain authoritative.
   */
  const hydrate = (r: StoredRound, current: CommitmentScheme): StoredRound => {
    if (["invalid_input", "unsupported_version"].includes(r.outcomeStatus)) return r;
    const mode = auditMode(r);
    const fresh = verifyRound(r.result.inputs, verifyOpts(current, mode, true));
    const reproduced = outcomeKey(r.game, fresh.calculated) === outcomeKey(r.game, r.calculated);
    const differs = fresh.overall !== r.overallStatus || fresh.outcome.status !== r.outcomeStatus || fresh.commitment.status !== r.commitmentStatus;
    const currentAssessment = differs ? { overall: fresh.overall, outcome: fresh.outcome.status, commitment: fresh.commitment.status } : null;
    const needsTrace = r.result.trace.length === 0;
    // Compact records keep only statuses, so their notes and comparison rows are rebuilt. They must be rebuilt
    // under the commitment scheme that produced the stored status, not today's setting: otherwise a record stored
    // as "scheme unconfirmed" would show a "commitment mismatch" row next to its stored badge.
    const storedScheme = schemeBehind(r.commitmentStatus);
    const asStored = !r.compact || storedScheme === null || storedScheme === current ? fresh : verifyRound(r.result.inputs, verifyOpts(storedScheme, mode, true));
    const result = r.compact
      ? {
          ...asStored,
          // authoritative stored facts
          outcome: r.result.outcome,
          overall: r.overallStatus,
          errors: r.result.errors,
          computedAt: r.result.computedAt,
          appVersion: r.result.appVersion,
          reported: r.recorded,
          calculated: r.calculated,
          commitment: { ...asStored.commitment, status: r.commitmentStatus },
          timing: { ...asStored.timing, status: r.timingStatus },
        }
      : { ...r.result, trace: needsTrace ? fresh.trace : r.result.trace, comparisons: r.result.comparisons.length ? r.result.comparisons : fresh.comparisons };
    return { ...r, result: result as StoredRound["result"], traceRegenerated: needsTrace, reproduced, currentAssessment };
  };

  // ---------------------------------------------------------------- auth
  const secureCookie = (req: FastifyRequest) => auth.hosted || req.protocol === "https";
  app.get("/api/auth/status", async (req) => ({
    required: auth.password !== null || auth.hosted,
    configured: auth.password !== null,
    authenticated: auth.password === null ? !auth.hosted : validSession(auth, readCookie(req.headers.cookie, SESSION_COOKIE)),
  }));
  app.post("/api/auth/login", async (req, reply) => {
    const { password } = parse(z.object({ password: z.string().max(1024) }), req.body ?? {});
    if (auth.password === null) throw new HttpError(400, auth.hosted ? "No password is configured for this deployment (SFL_PASSWORD)." : "This Fairness Lab has no login.");
    const who = req.ip;
    if (throttle.blocked(who)) throw new HttpError(429, "Too many failed attempts. Wait 15 minutes and try again.");
    if (!passwordMatches(auth, password)) {
      throttle.fail(who);
      await new Promise((r) => setTimeout(r, 750)); // slows guessing
      throw new HttpError(401, "Wrong password.");
    }
    throttle.succeed(who);
    reply.header("set-cookie", sessionCookie(issueSession(auth), SESSION_SECONDS, secureCookie(req)));
    return { authenticated: true };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    reply.header("set-cookie", sessionCookie("", 0, secureCookie(req)));
    return { authenticated: false };
  });

  // ---------------------------------------------------------------- meta
  app.get("/api/health", async () => ({ ok: true, version: APP_VERSION }));

  app.get("/api/meta", async () => ({
    version: APP_VERSION,
    schemaVersion: await db.schemaVersion(),
    migration: db.migration,
    hosted: !db.local,
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
    const result = verifyRound(body.input, verifyOpts(await scheme(), "manual"));
    const savedId = body.save ? await db.insertRound(result) : null;
    return { result, savedId };
  });

  app.post("/api/compare-versions", async (req) => {
    const input = parse(z.record(z.unknown()), req.body ?? {});
    const s = await scheme();
    return {
      note: "Exploratory: both versions are shown side by side. Which version applies to a round must come from the round's record - the Lab never selects a version because it matches.",
      results: ALGORITHM_VERSIONS.map((v) => verifyRound({ ...input, algorithmVersion: v }, verifyOpts(s, "manual"))),
    };
  });

  const hmacSchema = z.object({
    key: z.string().max(LIMITS.hmacPartLength),
    keyEncoding: z.enum(["utf8", "hex"]).default("utf8"),
    parts: boundedArray(z.object({ value: z.string().max(LIMITS.hmacPartLength), encoding: z.enum(["utf8", "hex", "uint32be"]).default("utf8") }), LIMITS.hmacParts).default([]),
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
    const p = parse(z.object({ parts: boundedArray(z.string().max(LIMITS.hmacPartLength), LIMITS.hmacParts) }), req.body);
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
    const r = await db.getRound(idParam(req));
    if (!r) throw new HttpError(404, "Not found");
    return hydrate(r, await scheme());
  });

  app.delete("/api/rounds/:id", async (req) => ({ deleted: await db.deleteRound(idParam(req)) }));

  /** Re-runs a stored round. With ?update=1 the record is re-audited (previous result kept in its history). */
  app.post("/api/rounds/:id/reverify", async (req) => {
    const id = idParam(req);
    const { update } = parse(z.object({ update: z.enum(["0", "1"]).optional() }), req.query);
    const r = await db.getRound(id);
    if (!r) throw new HttpError(404, "Not found");
    const fresh = verifyRound(r.result.inputs, verifyOpts(await scheme(), auditMode(r)));
    const reproduced = outcomeKey(r.game, fresh.calculated) === outcomeKey(r.game, r.calculated);
    if (update === "1") await db.sql.batch([db.reauditStatement(r, fresh)]);
    return { reproduced, updated: update === "1", fresh };
  });

  /** Bulk re-audit of a filtered set (e.g. after confirming the commitment scheme). Changes commit in atomic batches. */
  app.post("/api/rounds/reverify", async (req) => {
    const f = toFilter(parse(filterSchema, req.body ?? {}));
    const s = await scheme();
    let rounds = 0;
    let changed = 0;
    let reproduced = 0;
    let pending: Statement[] = [];
    const flush = async () => {
      await db.sql.batch(pending);
      pending = [];
      await yieldToEventLoop();
    };
    for await (const r of db.iterateRounds({ ...f, limit: undefined, offset: undefined })) {
      rounds++;
      const fresh = verifyRound(r.result.inputs, verifyOpts(s, auditMode(r), false));
      if (outcomeKey(r.game, fresh.calculated) === outcomeKey(r.game, r.calculated)) reproduced++;
      if (fresh.overall !== r.overallStatus || fresh.outcome.status !== r.outcomeStatus || fresh.commitment.status !== r.commitmentStatus) {
        pending.push(db.reauditStatement(r, fresh));
        changed++;
        if (pending.length >= 500) await flush();
      }
    }
    await flush();
    return { rounds, reproduced, statusChanged: changed };
  });

  app.get("/api/rounds/:id/script", async (req, reply) => {
    const r = await db.getRound(idParam(req));
    if (!r) throw new HttpError(404, "Not found");
    reply.header("content-disposition", `attachment; filename="round-${r.id}.mjs"`);
    return reply.type("text/javascript; charset=utf-8").send(standaloneScript(r));
  });

  // ---------------------------------------------------------------- imports
  const jobId = (req: FastifyRequest) => parse(z.object({ id: z.string().uuid() }), req.params).id;

  /**
   * Two ways to import:
   *  - `text`: the whole file in one request (small files, scripts). Verified and stored before responding.
   *  - no `text`: creates a job; the browser then uploads the file as numbered chunks (large files, and any
   *    file on hosted deployments, whose requests are limited to a few MB).
   */
  app.post("/api/import", { bodyLimit: LIMITS.importBytes + 1024 * 1024 }, async (req) => {
    const body = parse(
      z.object({
        text: z.string().min(1, "No data supplied").max(LIMITS.importBytes, `Import is larger than ${LIMITS.importBytes / 1024 / 1024} MB; split the file`).optional(),
        format: z.enum(["csv", "json", "jsonl", "auto"]).default("auto"),
        filename: z.string().max(LIMITS.textField).optional().nullable(),
        skipDuplicates: z.boolean().default(true),
        total: z.number().int().min(0).max(100_000_000).optional(),
      }),
      req.body ?? {},
    );
    if (body.text !== undefined) return { job: await imports.importText(body.text, body) };
    if (body.format === "auto") throw new HttpError(400, "format: a chunked import must name its format (csv, json or jsonl)");
    return { job: await imports.create({ format: body.format, filename: body.filename, total: body.total ?? 0, skipDuplicates: body.skipDuplicates }) };
  });

  app.post("/api/import/jobs/:id/chunks", async (req) => {
    const p = parse(
      z.object({
        seq: z.number().int().min(0),
        text: z.string().max(LIMITS.importChunkChars, `chunk is larger than ${LIMITS.importChunkChars} characters`),
        lineOffset: z.number().int().min(0).default(0),
      }),
      req.body ?? {},
    );
    return imports.chunk(jobId(req), p.seq, p.text, p.lineOffset);
  });

  app.get("/api/import/jobs/:id", async (req) => {
    const job = await imports.get(jobId(req));
    if (!job) throw new HttpError(404, "Unknown import");
    return job;
  });

  app.post("/api/import/jobs/:id/:action", async (req) => {
    const { action } = parse(z.object({ id: z.string(), action: z.enum(["pause", "resume", "cancel", "finish"]) }), req.params);
    const id = jobId(req);
    return action === "finish" ? imports.finish(id) : imports.control(id, action);
  });

  app.get("/api/imports", async () => db.listImports());

  // ---------------------------------------------------------------- analytics
  // Derived views are cached until the data changes (db.dataVersion(), read from the database so that several
  // server instances never serve each other's stale results) - repeated dashboard visits are cheap.
  const cache = new Map<string, { version: string; value: unknown }>();
  const cached = async <T>(key: string, compute: () => Promise<T>): Promise<T> => {
    const version = await db.dataVersion();
    const hit = cache.get(key);
    if (hit && hit.version === version) return hit.value as T;
    const value = await compute();
    if (cache.size > 200) cache.clear();
    cache.set(key, { version, value });
    return value;
  };
  app.get("/api/stats", async (req) => {
    const f = toFilter(parse(filterSchema, req.query));
    return cached(`stats:${JSON.stringify(f)}`, () => db.stats(f));
  });
  app.get("/api/integrity", async () => cached("integrity", () => runIntegrityAudit(db.sql)));
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
    const total = await db.countRounds(f);
    if ((q.format === "html" || q.format === "pdf") && total > LIMITS.htmlPdfExportRounds) {
      throw new HttpError(413, `${total} records selected; HTML/PDF reports are limited to ${LIMITS.htmlPdfExportRounds}. Filter by game, status or import batch, or use CSV/JSON.`);
    }
    const withTraces = total <= LIMITS.jsonExportTraceRounds;
    const s = await scheme();
    const rounds: StoredRound[] = [];
    for await (const r of db.iterateRounds({ ...f, limit: undefined, offset: undefined })) rounds.push(withTraces ? hydrate(r, s) : r);
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
          // hosted, the server makes this request: plain http is refused there
          .refine((u) => (auth.hosted ? /^https:$/ : /^https?:$/).test(new URL(u).protocol), auth.hosted ? "RPC URL must use https" : "RPC URL must use http or https")
          .optional(),
      }),
      req.body,
    );
    return db.setSettings(p);
  });

  app.post("/api/backup", async () => {
    if (!db.local) {
      throw new HttpError(
        501,
        "This deployment uses a hosted database. Backups and point-in-time restore are provided by the database service (Turso); use the JSON export for a portable copy of the records.",
      );
    }
    const file = await db.backup("manual");
    return { file, bytes: statSync(file).size };
  });

  app.post("/api/chain/tx", async (req) => {
    const p = parse(z.object({ signature: z.string().max(128), needles: boundedArray(z.string().max(1024), 20).default([]) }), req.body);
    try {
      return await fetchTransactionEvidence((await db.getSettings()).solanaRpcUrl, p.signature.trim(), p.needles);
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

  return { app, db, imports };
}
