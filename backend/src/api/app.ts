import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { FairnessDb } from "../database/db.js";
import { verifyRound, APP_VERSION } from "../verification/engine.js";
import { parseImport } from "../imports/parse.js";
import { computeStats } from "../auditing/stats.js";
import { runIntegrityAudit } from "../auditing/integrity.js";
import { toCsv, toHtml, toJson, toPdf } from "../exports/reports.js";
import { fetchTransactionEvidence } from "../blockchain/solana.js";
import { hmacSha256Hex, sha256Hex } from "../crypto/hmac.js";
import { buildTranscript, V2_PROTOCOL_LABEL } from "../crypto/transcript.js";
import { BOARD_BY_MODE, KENO_DIFFICULTIES } from "../games/keno.js";
import { MINES_GRID_SIZES } from "../games/mines.js";
import { ALGORITHM_VERSIONS, BLACKJACK_VERSION, CRASH_VERSION } from "../types.js";

export interface AppOptions {
  db?: FairnessDb;
  staticDir?: string;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions = {}) {
  const db = opts.db ?? new FairnessDb();
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 50 * 1024 * 1024 });
  await app.register(cors, { origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] });

  const verifyOpts = (mode: "manual" | "import") => ({ commitmentScheme: db.getSettings().commitmentScheme, mode });
  const bad = (reply: any, message: string, code = 400) => reply.code(code).send({ error: message });

  app.get("/api/health", async () => ({ ok: true, version: APP_VERSION }));

  app.get("/api/meta", async () => ({
    version: APP_VERSION,
    algorithmVersions: ALGORITHM_VERSIONS,
    crashVersion: CRASH_VERSION,
    blackjackVersion: BLACKJACK_VERSION,
    keno: { difficulties: KENO_DIFFICULTIES, boards: BOARD_BY_MODE, minPicks: 1, maxPicks: 10 },
    mines: { gridSizes: MINES_GRID_SIZES },
    v2ProtocolLabel: V2_PROTOCOL_LABEL,
  }));

  app.post("/api/verify", async (req) => {
    const { input, save } = (req.body ?? {}) as { input?: unknown; save?: boolean };
    const result = verifyRound(input, verifyOpts("manual"));
    const savedId = save ? db.insertRound(result) : null;
    return { result, savedId };
  });

  app.post("/api/compare-versions", async (req) => {
    const input = (req.body ?? {}) as Record<string, unknown>;
    return {
      note: "Both versions are shown side by side for inspection. The lab never selects a version based on which one matches.",
      results: ALGORITHM_VERSIONS.map((v) => verifyRound({ ...input, algorithmVersion: v }, verifyOpts("manual"))),
    };
  });

  const hmacSchema = z.object({
    key: z.string(),
    keyEncoding: z.enum(["utf8", "hex"]).default("utf8"),
    parts: z.array(z.object({ value: z.string(), encoding: z.enum(["utf8", "hex", "uint32be"]).default("utf8") })).default([]),
  });
  app.post("/api/tools/hmac", async (req, reply) => {
    const p = hmacSchema.safeParse(req.body);
    if (!p.success) return bad(reply, p.error.issues.map((i) => i.message).join("; "));
    try {
      const toBuf = (value: string, enc: string) => {
        if (enc === "hex") {
          if (!/^([0-9a-fA-F]{2})*$/.test(value)) throw new Error(`"${value.slice(0, 20)}" is not valid hex`);
          return Buffer.from(value, "hex");
        }
        if (enc === "uint32be") {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("uint32be value must be 0-4294967295");
          const b = Buffer.alloc(4);
          b.writeUInt32BE(n);
          return b;
        }
        return Buffer.from(value, "utf8");
      };
      const key = toBuf(p.data.key, p.data.keyEncoding);
      const parts = p.data.parts.map((x) => toBuf(x.value, x.encoding));
      return {
        keyHex: key.toString("hex"),
        messageHex: Buffer.concat(parts).toString("hex"),
        hmac: hmacSha256Hex(key, ...parts),
        sha256OfKey: sha256Hex(key),
      };
    } catch (e) {
      return bad(reply, (e as Error).message);
    }
  });

  app.post("/api/tools/transcript", async (req, reply) => {
    const p = z.object({ parts: z.array(z.string()) }).safeParse(req.body);
    if (!p.success) return bad(reply, "parts must be an array of strings");
    return { hex: buildTranscript(p.data.parts).toString("hex") };
  });

  const listQuery = z.object({
    game: z.string().optional(),
    status: z.string().optional(),
    q: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(5000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    ids: z.string().optional(),
  });
  const parseIds = (s?: string) => (s ? s.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0) : undefined);

  app.get("/api/rounds", async (req) => {
    const q = listQuery.parse(req.query);
    return db.listRounds({ ...q, ids: parseIds(q.ids) });
  });

  app.get("/api/rounds/:id", async (req, reply) => {
    const r = db.getRound(Number((req.params as { id: string }).id));
    return r ?? bad(reply, "Not found", 404);
  });

  app.delete("/api/rounds/:id", async (req) => ({ deleted: db.deleteRound(Number((req.params as { id: string }).id)) }));

  /** Re-runs the stored inputs and reports whether the calculation is reproduced bit-for-bit. */
  app.post("/api/rounds/:id/reverify", async (req, reply) => {
    const r = db.getRound(Number((req.params as { id: string }).id));
    if (!r) return bad(reply, "Not found", 404);
    const fresh = verifyRound(r.result.inputs, verifyOpts("import"));
    const reproduced = JSON.stringify(fresh.calculated) === JSON.stringify(r.result.calculated);
    return { reproduced, stored: r.result, fresh };
  });

  app.post("/api/import", async (req, reply) => {
    const body = (req.body ?? {}) as { text?: string; format?: string; filename?: string };
    if (typeof body.text !== "string" || !body.text.length) return bad(reply, "No data supplied");
    const format = (["csv", "json", "jsonl", "auto"].includes(body.format ?? "") ? body.format : "auto") as "csv" | "json" | "jsonl" | "auto";
    const parsed = parseImport(body.text, format);
    const batchId = randomUUID();
    const rejected: { line: number; error: string }[] = [];
    const stored: { id: number; line: number; roundId: string | null; game: string; outcome: string; overall: string }[] = [];
    const opts = verifyOpts("import");
    db.db.exec("BEGIN");
    try {
      for (const row of parsed.rows) {
        if (!row.input) {
          rejected.push({ line: row.line, error: row.error ?? "Unparseable row" });
          continue;
        }
        const result = verifyRound(row.input, opts);
        if (!["crash", "blackjack", "keno", "mines"].includes(String(result.game))) {
          rejected.push({ line: row.line, error: `Unknown game "${String(result.game)}"` });
          continue;
        }
        const id = db.insertRound(result, batchId);
        stored.push({ id, line: row.line, roundId: result.roundId, game: String(result.game), outcome: result.outcome.status, overall: result.overall });
      }
      db.db.exec("COMMIT");
    } catch (e) {
      db.db.exec("ROLLBACK");
      throw e;
    }
    db.recordImport({ id: batchId, format: parsed.format, filename: body.filename ?? null, total: parsed.rows.length, stored: stored.length, rejected: rejected.length, errors: rejected });
    return { batchId, format: parsed.format, total: parsed.rows.length, stored, rejected };
  });

  app.get("/api/imports", async () => db.listImports());
  app.get("/api/stats", async () => computeStats(db.listRounds().rounds));
  app.get("/api/integrity", async () => runIntegrityAudit(db.listRounds().rounds));

  app.get("/api/export", async (req, reply) => {
    const q = listQuery.extend({ format: z.enum(["csv", "json", "html", "pdf"]) }).safeParse(req.query);
    if (!q.success) return bad(reply, "format must be csv, json, html or pdf");
    const { rounds } = db.listRounds({ game: q.data.game, status: q.data.status, q: q.data.q, ids: parseIds(q.data.ids) });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `solpump-fairness-report-${stamp}.${q.data.format}`;
    reply.header("content-disposition", `attachment; filename="${name}"`);
    switch (q.data.format) {
      case "csv":
        return reply.type("text/csv; charset=utf-8").send(toCsv(rounds));
      case "json":
        return reply.type("application/json; charset=utf-8").send(toJson(rounds));
      case "html":
        return reply.type("text/html; charset=utf-8").send(toHtml(rounds));
      case "pdf":
        return reply.type("application/pdf").send(await toPdf(rounds));
    }
  });

  app.get("/api/settings", async () => db.getSettings());
  app.put("/api/settings", async (req, reply) => {
    const p = z
      .object({ commitmentScheme: z.enum(["unconfirmed", "sha256_utf8_hex"]).optional(), solanaRpcUrl: z.string().url().optional() })
      .safeParse(req.body);
    if (!p.success) return bad(reply, p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return db.setSettings(p.data);
  });

  app.post("/api/chain/tx", async (req, reply) => {
    const p = z.object({ signature: z.string(), needles: z.array(z.string()).default([]) }).safeParse(req.body);
    if (!p.success) return bad(reply, "signature is required");
    try {
      return await fetchTransactionEvidence(db.getSettings().solanaRpcUrl, p.data.signature.trim(), p.data.needles);
    } catch (e) {
      return bad(reply, (e as Error).message, 502);
    }
  });

  if (opts.staticDir && existsSync(opts.staticDir)) {
    await app.register(fastifyStatic, { root: opts.staticDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  return { app, db };
}
