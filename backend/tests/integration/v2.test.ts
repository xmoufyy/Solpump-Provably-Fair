/**
 * Integration tests for v2 behaviour: migrations, import jobs, SQL analytics, integrity checks,
 * trace regeneration, re-audits, standalone scripts, export limits.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildApp } from "../../src/api/app.js";
import { FairnessDb } from "../../src/database/db.js";
import { SCHEMA_VERSION } from "../../src/database/migrations.js";
import type { ImportJob } from "../../../shared/src/contracts.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const V1_FIXTURE = join(repoRoot, "fixtures/db/v1-schema0.db");
const tmp = mkdtempSync(join(tmpdir(), "sfl-v2-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function fresh(name: string) {
  return buildApp({ db: new FairnessDb(join(tmp, `${name}.db`)) });
}

describe("migration of an authentic v1 database", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  const path = join(tmp, "migrate", "fairness-lab.db");
  beforeAll(async () => {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(V1_FIXTURE, path);
    ctx = await buildApp({ db: new FairnessDb(path) });
  });
  afterAll(async () => {
    await ctx.app.close();
    ctx.db.db.close();
  });

  it("upgrades schema v0 -> v1 and writes a backup first", () => {
    expect(ctx.db.migration).toMatchObject({ from: 0, to: SCHEMA_VERSION });
    expect(ctx.db.migration?.backup && existsSync(ctx.db.migration.backup)).toBe(true);
    expect(ctx.db.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("keeps every record and the import history", async () => {
    expect((await ctx.app.inject({ url: "/api/rounds" })).json().total).toBe(29);
    expect((await ctx.app.inject({ url: "/api/imports" })).json()).toHaveLength(1);
  });

  it("remaps the v1 commitment-mismatch record to the new final assessment only", async () => {
    const stats = (await ctx.app.inject({ url: "/api/stats" })).json();
    expect(stats.overall.mismatch).toBe(2);
    expect(stats.overall.commitment_mismatch).toBe(1);
  });

  it("v1 rows (full result_json with trace) still open and reproduce exactly", async () => {
    const { rounds } = (await ctx.app.inject({ url: "/api/rounds?q=v1-mines" })).json();
    const r = (await ctx.app.inject({ url: `/api/rounds/${rounds[0].id}` })).json();
    expect(r.result.trace.length).toBeGreaterThan(5);
    expect(r.traceRegenerated).toBe(false);
    expect(r.reproduced).toBe(true);
  });

  it("re-importing the same file into the migrated DB is idempotent (fingerprints were backfilled)", async () => {
    const text = readFileSync(join(repoRoot, "fixtures/sample-import-synthetic.csv"), "utf8");
    const { job } = (await ctx.app.inject({ method: "POST", url: "/api/import?wait=1", payload: { text, format: "csv" } })).json();
    expect(job.duplicates).toBe(27);
    expect(job.stored).toBe(0);
  });

  it("down-migration restores the v0 schema and data, and up again is lossless", () => {
    const copy = join(tmp, "roundtrip.db");
    copyFileSync(V1_FIXTURE, copy);
    const db = new FairnessDb(copy);
    const before = db.db.prepare("SELECT id, overall_status, outcome_status FROM rounds ORDER BY id").all();
    db.migrateDown(0);
    expect(db.schemaVersion).toBe(0);
    const cols = (db.db.prepare("PRAGMA table_info(rounds)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("fingerprint");
    expect((db.db.prepare("SELECT COUNT(*) n FROM rounds WHERE overall_status = 'commitment_mismatch'").get() as { n: number }).n).toBe(0);
    db.db.close();
    const again = new FairnessDb(copy);
    expect(again.schemaVersion).toBe(SCHEMA_VERSION);
    expect(again.db.prepare("SELECT id, overall_status, outcome_status FROM rounds ORDER BY id").all()).toEqual(before);
    again.db.close();
  });

  it("refuses to open a database from a newer schema", () => {
    const p = join(tmp, "future.db");
    const db = new FairnessDb(p);
    db.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.db.close();
    expect(() => new FairnessDb(p)).toThrow(/newer than this application/);
  });

  it("an empty database migrates without creating a backup", () => {
    const p = join(tmp, "empty", "x.db");
    const db = new FairnessDb(p);
    expect(db.migration).toMatchObject({ from: 0, backup: null });
    expect(existsSync(join(dirname(p), "backups"))).toBe(false);
    db.db.close();
  });
});

function syntheticCsv(n: number) {
  const lines = ["round_id,game,server_seed,client_seed,reported_outcome,source"];
  for (let i = 0; i < n; i++) lines.push(`r${i},crash,seed-${i},client,1.00,bulk`);
  return lines.join("\n");
}

describe("import jobs", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => (ctx = await fresh("jobs")));
  afterAll(async () => {
    await ctx.app.close();
    ctx.db.db.close();
  });
  const poll = async (id: string, until: (j: ImportJob) => boolean) => {
    for (let i = 0; i < 2000; i++) {
      const j = (await ctx.app.inject({ url: `/api/import/jobs/${id}` })).json() as ImportJob;
      if (until(j)) return j;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timeout");
  };

  it("runs in the background and reports progress", async () => {
    const { job } = (await ctx.app.inject({ method: "POST", url: "/api/import", payload: { text: syntheticCsv(3000), format: "csv" } })).json();
    expect(job.status).toBe("running");
    expect(job.total).toBe(3000);
    const done = await poll(job.id, (j) => j.status === "completed");
    expect(done.processed).toBe(3000);
    expect(done.stored).toBe(3000);
    expect(done.outcomeCounts.match! + done.outcomeCounts.mismatch!).toBe(3000);
  });

  it("can be paused, resumed and cancelled; committed rows are complete and tagged", async () => {
    const { job } = (await ctx.app.inject({ method: "POST", url: "/api/import", payload: { text: syntheticCsv(20000).replace(/r(\d+),/g, "p$1,").replace(/seed-/g, "pseed-"), format: "csv" } })).json();
    await ctx.app.inject({ method: "POST", url: `/api/import/jobs/${job.id}/pause` });
    const paused = await poll(job.id, (j) => j.status === "paused");
    const processedWhilePaused = paused.processed;
    await new Promise((r) => setTimeout(r, 50));
    expect((await ctx.app.inject({ url: `/api/import/jobs/${job.id}` })).json().processed).toBe(processedWhilePaused);
    await ctx.app.inject({ method: "POST", url: `/api/import/jobs/${job.id}/resume` });
    await poll(job.id, (j) => j.processed > processedWhilePaused);
    await ctx.app.inject({ method: "POST", url: `/api/import/jobs/${job.id}/cancel` });
    const cancelled = await poll(job.id, (j) => j.status === "cancelled");
    expect(cancelled.processed).toBeLessThan(20000);
    // every committed row is a full verification, and counts agree with the database
    expect(ctx.db.countRounds({ batch: job.id })).toBe(cancelled.stored);
    expect(ctx.db.countRounds({ batch: job.id, outcome: "match" }) + ctx.db.countRounds({ batch: job.id, outcome: "mismatch" })).toBe(cancelled.stored);
    expect(ctx.db.getImport(job.id)?.status).toBe("cancelled");
  });

  it("keeps the API responsive while a 20,000-row import runs", async () => {
    const { job } = (await ctx.app.inject({ method: "POST", url: "/api/import", payload: { text: syntheticCsv(20000).replace(/r(\d+),/g, "q$1,").replace(/seed-/g, "qseed-"), format: "csv" } })).json();
    // Requests arrive from the network (timers here); in-process inject() alone would starve the
    // job's setImmediate yields, which real HTTP traffic never does.
    let worst = 0;
    const deadline = Date.now() + 60000;
    while ((await ctx.app.inject({ url: `/api/import/jobs/${job.id}` })).json().status === "running" && Date.now() < deadline) {
      const scheduled = performance.now();
      await new Promise((r) => setTimeout(r, 5));
      await ctx.app.inject({ url: "/api/health" });
      worst = Math.max(worst, performance.now() - scheduled - 5);
    }
    expect((await ctx.app.inject({ url: `/api/import/jobs/${job.id}` })).json().status).toBe("completed");
    expect(worst).toBeLessThan(250);
  });

  it("skips exact duplicates (idempotent re-import) unless asked not to", async () => {
    const text = syntheticCsv(50);
    const a = (await ctx.app.inject({ method: "POST", url: "/api/import?wait=1", payload: { text, format: "csv" } })).json().job;
    const b = (await ctx.app.inject({ method: "POST", url: "/api/import?wait=1", payload: { text, format: "csv" } })).json().job;
    const c = (await ctx.app.inject({ method: "POST", url: "/api/import?wait=1", payload: { text, format: "csv", skipDuplicates: false } })).json().job;
    expect([a.stored, b.stored, b.duplicates, c.stored]).toEqual([0, 0, 50, 50]); // first 50 already stored by test 1
  });

  it("controls on unknown or finished jobs are rejected cleanly", async () => {
    expect((await ctx.app.inject({ url: "/api/import/jobs/not-a-uuid" })).statusCode).toBe(400);
    const { job } = (await ctx.app.inject({ method: "POST", url: "/api/import?wait=1", payload: { text: syntheticCsv(1), format: "csv", skipDuplicates: false } })).json();
    expect((await ctx.app.inject({ method: "POST", url: `/api/import/jobs/${job.id}/pause` })).statusCode).toBe(409);
  });
});

describe("analytics, integrity, re-audit, scripts, exports", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    ctx = await fresh("analytics");
    const text = readFileSync(join(repoRoot, "fixtures/sample-import-synthetic.csv"), "utf8");
    await ctx.app.inject({ method: "POST", url: "/api/import?wait=1", payload: { text, format: "csv" } });
  });
  afterAll(async () => {
    await ctx.app.close();
    ctx.db.db.close();
  });

  it("SQL stats agree with a straightforward count over the rows", async () => {
    const stats = (await ctx.app.inject({ url: "/api/stats" })).json();
    const rows = [...ctx.db.iterateSummaries()];
    expect(stats.metrics.totalRounds).toBe(rows.length);
    expect(stats.metrics.matching).toBe(rows.filter((r) => r.outcomeStatus === "match").length);
    expect(stats.metrics.mismatches).toBe(rows.filter((r) => r.outcomeStatus === "mismatch").length);
    for (const g of stats.byGame) expect(g.match + g.mismatch).toBe(rows.filter((r) => r.game === g.game).length);
    expect(stats.overTime.reduce((a: number, d: { match: number; mismatch: number; other: number }) => a + d.match + d.mismatch + d.other, 0)).toBe(rows.length);
  });

  it("integrity: reused commitment and conflicting nonce reuse are contradictions", async () => {
    const save = (input: Record<string, unknown>) => ctx.app.inject({ method: "POST", url: "/api/verify", payload: { save: true, input } });
    await save({ game: "crash", serverSeed: "zz-commit-A", clientSeed: "p", commitment: "ab".repeat(32), roundId: "ca", source: "t" });
    await save({ game: "crash", serverSeed: "zz-commit-B", clientSeed: "p", commitment: "AB".repeat(32), roundId: "cb", source: "t" });
    const base = { game: "keno", serverSeed: "kseed", clientSeed: "kc", nonce: "5", algorithmVersion: "hmac_sha256_v2", difficulty: "CLASSIC", source: "t" };
    await save({ ...base, roundId: "k-1", reported: { draw: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } });
    await save({ ...base, roundId: "k-2", reported: { draw: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20] } });
    const rep = (await ctx.app.inject({ url: "/api/integrity" })).json();
    const reused = rep.findings.find((f: { check: string }) => f.check === "reused_commitment");
    expect(reused).toMatchObject({ kind: "contradiction", totalRounds: 2 });
    expect(rep.findings.find((f: { check: string }) => f.check === "nonce_reuse_conflicting_outcomes")?.kind).toBe("contradiction");
    expect(rep.findings[0].kind).toBe("contradiction"); // contradictions sorted first
  });

  it("integrity: nonce going backwards is an anomaly", async () => {
    const save = (nonce: string, ts: string) =>
      ctx.app.inject({ method: "POST", url: "/api/verify", payload: { save: true, input: { game: "mines", serverSeed: "ns", clientSeed: "nc", nonce, algorithmVersion: "v2x", gridSize: 5, mineCount: 3, timestamp: ts } } });
    await save("7", "2026-10-01T00:00:00Z");
    await save("3", "2026-10-02T00:00:00Z");
    const rep = (await ctx.app.inject({ url: "/api/integrity" })).json();
    expect(rep.findings.find((f: { check: string }) => f.check === "nonce_reset")?.kind).toBe("anomaly");
  });

  it("imported rounds have no stored trace; the detail view regenerates it and confirms reproduction", async () => {
    const { rounds } = (await ctx.app.inject({ url: "/api/rounds?q=keno-3" })).json();
    const d = (await ctx.app.inject({ url: `/api/rounds/${rounds[0].id}` })).json();
    expect(d.traceRegenerated).toBe(true);
    expect(d.reproduced).toBe(true);
    expect(d.result.trace.some((t: { section: string }) => t.section === "Draw")).toBe(true);
  });

  it("bulk re-audit after confirming the commitment scheme keeps the previous audit", async () => {
    await ctx.app.inject({ method: "PUT", url: "/api/settings", payload: { commitmentScheme: "sha256_utf8_hex" } });
    const r = (await ctx.app.inject({ method: "POST", url: "/api/rounds/reverify", payload: { q: "zz-commit-A" } })).json();
    expect(r).toMatchObject({ rounds: 1, reproduced: 1, statusChanged: 1 });
    const { rounds } = (await ctx.app.inject({ url: "/api/rounds?q=zz-commit-A" })).json();
    const d = (await ctx.app.inject({ url: `/api/rounds/${rounds[0].id}` })).json();
    expect(d.commitmentStatus).toBe("mismatch");
    expect(d.previousAudits).toHaveLength(1);
    expect(d.previousAudits[0].commitment).toBe("scheme_unconfirmed");
    await ctx.app.inject({ method: "PUT", url: "/api/settings", payload: { commitmentScheme: "unconfirmed" } });
  });

  it("standalone scripts reproduce every game and both versions without the Lab", async () => {
    const dir = join(repoRoot, ".tmp", "scripts");
    mkdirSync(dir, { recursive: true });
    const { rounds } = (await ctx.app.inject({ url: "/api/rounds?limit=500&batch=" + ctx.db.listImports()[0].id })).json();
    const picks = ["crash-1", "bj-1", "keno-1", "keno-11", "mines-6", "mines-16", "crash-6", "mines-20"].map((id) => rounds.find((r: { roundId: string }) => r.roundId === id));
    for (const r of picks) {
      const script = (await ctx.app.inject({ url: `/api/rounds/${r.id}/script` })).body;
      const file = join(dir, `round-${r.id}.mjs`);
      writeFileSync(file, script);
      const run = spawnSync(process.execPath, [file], { encoding: "utf8", cwd: dir });
      expect(run.status, run.stderr).toBe(0);
      const out = JSON.parse(run.stdout);
      expect(out.agreesWithLab).toBe(true);
      expect(out.matchesRecorded).toBe(!["crash-6", "mines-20"].includes(r.roundId)); // the two planted mismatches
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("seed strings cannot inject code into the standalone script", async () => {
    const evil = '"; process.exit(7); // */`${process.exit(8)}`';
    const { savedId } = (await ctx.app.inject({ method: "POST", url: "/api/verify", payload: { save: true, input: { game: "crash", serverSeed: evil, clientSeed: evil, roundId: "*/ evil" } } })).json();
    const dir = join(repoRoot, ".tmp", "scripts2");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "evil.mjs");
    writeFileSync(file, (await ctx.app.inject({ url: `/api/rounds/${savedId}/script` })).body);
    const run = spawnSync(process.execPath, [file], { encoding: "utf8" });
    expect(run.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("CSV export streams; HTML/PDF are bounded with a clear 413", async () => {
    const csv = await ctx.app.inject({ url: "/api/export?format=csv" });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split("\r\n").length).toBeGreaterThan(28);
    const big = await fresh("big-export");
    await big.app.inject({ method: "POST", url: "/api/import?wait=1", payload: { text: syntheticCsv(1001), format: "csv" } });
    const r = await big.app.inject({ url: "/api/export?format=html" });
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toMatch(/limited to 1000/);
    expect((await big.app.inject({ url: "/api/export?format=html&limit=1&ids=1" })).statusCode).toBe(200);
    await big.app.close();
    big.db.db.close();
  });

  it("HTML report contains the five evidence sections and the comparison table", async () => {
    const html = (await ctx.app.inject({ url: "/api/export?format=html&q=crash-6" })).body;
    for (const s of ["1. Outcome reconstruction", "2. Outcome comparison", "3. Seed commitment", "4. Historical (timing) evidence", "5. Final assessment", "Reported vs reconstructed", "Limitations", "Provenance"]) {
      expect(html).toContain(s);
    }
    expect(html).toContain('class="mismatch"');
  });

  it("seed sessions group rounds per seed pair and flag conflicts", async () => {
    const r = (await ctx.app.inject({ url: "/api/sessions?game=keno" })).json();
    const k = r.sessions.find((s: { serverSeed: string }) => s.serverSeed === "kseed");
    expect(k.rounds).toBe(2);
    expect(k.conflicts.join(" ")).toMatch(/repeated nonce/);
  });

  it("backup endpoint writes a consistent snapshot", async () => {
    const b = (await ctx.app.inject({ method: "POST", url: "/api/backup" })).json();
    expect(existsSync(b.file)).toBe(true);
    expect(readdirSync(dirname(b.file)).length).toBeGreaterThan(0);
    const snap = new FairnessDb(b.file);
    expect(snap.countRounds()).toBe(ctx.db.countRounds());
    snap.db.close();
  });
});

describe("schema stability", () => {
  it("re-opening a migrated database does not resurrect dropped indexes", () => {
    const p = join(tmp, "reopen.db");
    new FairnessDb(p).db.close();
    const db = new FairnessDb(p);
    const idx = (db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).not.toContain("idx_rounds_game");
    expect(idx).toContain("idx_rounds_seed_ctx");
    db.db.close();
  });
});
