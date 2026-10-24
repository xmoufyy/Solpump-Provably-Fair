/**
 * Regression tests for defects found in the third audit (G-01, G-02, G-06 .. G-10).
 * Each test failed against the code before the fix. Data is synthetic and lives in a temp directory.
 */
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir } from "./cleanup.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { buildApp } from "../../src/api/app.js";
import { FairnessDb } from "../../src/database/db.js";
import type { ImportJob, IntegrityReport, StoredRound } from "../../../shared/src/contracts.js";

const tmp = mkdtempSync(join(tmpdir(), "sfl-audit3-"));
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterAll(async () => {
  for (const a of apps) {
    await a.app.close();
    a.db.close();
  }
  removeTempDir(tmp);
});
async function fresh() {
  const ctx = await buildApp({ db: await FairnessDb.open(":memory:") });
  apps.push(ctx);
  const call = async <T = unknown>(method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<T> => {
    const res = await ctx.app.inject({ method, url, payload: payload as object | undefined });
    if (res.statusCode >= 400 && !url.includes("/script")) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
    return (url.includes("/script") ? res.body : res.json()) as T;
  };
  const importJson = async (rows: unknown[]) => (await call<{ job: ImportJob }>("POST", "/api/import?wait=1", { format: "json", text: JSON.stringify(rows) })).job;
  return { ...ctx, call, importJson };
}
const S = "SERVER_TEST_2026", C = "CLIENT_TEST_2026"; // Crash = 1.25x

describe("G-01 Re-audit: saved manual reconstructions were re-assessed as imports", () => {
  it("a manual reconstruction stays 'reconstructed' when opened and re-audited", async () => {
    const t = await fresh();
    const { savedId } = await t.call<{ savedId: number }>("POST", "/api/verify", { save: true, input: { game: "crash", serverSeed: S, clientSeed: C } });
    const detail = await t.call<StoredRound>("GET", `/api/rounds/${savedId}`);
    expect(detail.outcomeStatus).toBe("reconstructed");
    expect(detail.currentAssessment).toBeNull();
    expect(await t.call("POST", "/api/rounds/reverify", {})).toMatchObject({ rounds: 1, statusChanged: 0 });
    const single = await t.call<{ fresh: { outcome: { status: string } } }>("POST", `/api/rounds/${savedId}/reverify`);
    expect(single.fresh.outcome.status).toBe("reconstructed");
  });
  it("an imported record without an outcome is still a gap ('missing comparison')", async () => {
    const t = await fresh();
    await t.importJson([{ game: "crash", serverSeed: S, clientSeed: C }]);
    expect(await t.call("POST", "/api/rounds/reverify", {})).toMatchObject({ rounds: 1, statusChanged: 0 });
    const { rounds } = await t.call<{ rounds: { outcomeStatus: string }[] }>("GET", "/api/rounds");
    expect(rounds[0].outcomeStatus).toBe("missing_comparison");
  });
});

describe("G-02 Detail view: compact records showed commitment notes from today's settings", () => {
  it("rebuilt notes and rows agree with the stored status; the new assessment is reported separately", async () => {
    const t = await fresh();
    await t.importJson([{ game: "crash", serverSeed: S, clientSeed: C, multiplier: 1.25, commitment: "00".repeat(32) }]);
    await t.call("PUT", "/api/settings", { commitmentScheme: "sha256_utf8_hex" });
    const { rounds } = await t.call<{ rounds: { id: number }[] }>("GET", "/api/rounds");
    const d = await t.call<StoredRound>("GET", `/api/rounds/${rounds[0].id}`);
    expect(d.commitmentStatus).toBe("scheme_unconfirmed");
    expect(d.result.commitment.status).toBe("scheme_unconfirmed");
    expect(d.result.commitment.note).toMatch(/not confirmed/);
    expect(d.result.comparisons.find((c) => c.field.startsWith("Commitment"))?.status).toBe("info");
    expect(d.currentAssessment).toMatchObject({ commitment: "mismatch", overall: "commitment_mismatch" });
  });
});

describe("G-06 Seed sessions: large nonces and comma-containing sources", () => {
  it("nonce range keeps every digit and a source with a comma stays one source", async () => {
    const t = await fresh();
    const base = { game: "keno", serverSeed: S, clientSeed: C, algorithmVersion: "v2", difficulty: "CLASSIC", source: "Solpump export, page 2" };
    await t.importJson([{ ...base, nonce: "9007199254740993" }, { ...base, nonce: "9007199254740995" }, { ...base, nonce: "12345678901234567890123" }]);
    const { sessions } = await t.call<{ sessions: { nonceMin: string; nonceMax: string; sources: string[] }[] }>("GET", "/api/sessions");
    expect(sessions[0].nonceMin).toBe("9007199254740993");
    expect(sessions[0].nonceMax).toBe("12345678901234567890123");
    expect(sessions[0].sources).toEqual(["Solpump export, page 2"]);
  });
});

describe("G-07 Integrity: classification of conflicting Crash records and large-nonce resets", () => {
  it("one Crash seed pair with two different reported multipliers is a contradiction", async () => {
    const t = await fresh();
    await t.importJson([
      { game: "crash", roundId: "a", serverSeed: S, clientSeed: C, multiplier: 1.25 },
      { game: "crash", roundId: "b", serverSeed: S, clientSeed: C, multiplier: 3 },
    ]);
    const report = await t.call<IntegrityReport>("GET", "/api/integrity");
    expect(report.findings.find((f) => f.check.startsWith("seed_pair_reuse"))).toMatchObject({ check: "seed_pair_reuse_conflicting_outcomes", kind: "contradiction" });
  });
  it("the same seed pair with the same multiplier stays an anomaly (not proof of anything)", async () => {
    const t = await fresh();
    await t.importJson([
      { game: "crash", roundId: "a", serverSeed: S, clientSeed: C, multiplier: 1.25 },
      { game: "crash", roundId: "b", serverSeed: S, clientSeed: C, multiplier: 1.25 },
    ]);
    const report = await t.call<IntegrityReport>("GET", "/api/integrity");
    expect(report.findings.find((f) => f.check.startsWith("seed_pair_reuse"))).toMatchObject({ check: "seed_pair_reuse", kind: "anomaly" });
  });
  it("nonce order is numeric beyond 2^63 (no false reset, no missed reset)", async () => {
    const t = await fresh();
    const k = { game: "keno", serverSeed: S, clientSeed: C, algorithmVersion: "v2", difficulty: "CLASSIC" };
    await t.importJson([
      { ...k, nonce: "99999999999999999998", timestamp: "2026-01-01T00:00:01Z" },
      { ...k, nonce: "99999999999999999999", timestamp: "2026-01-01T00:00:02Z" },
      { ...k, nonce: "100000000000000000000", timestamp: "2026-01-01T00:00:03Z" },
    ]);
    expect((await t.call<IntegrityReport>("GET", "/api/integrity")).findings.some((f) => f.check === "nonce_reset")).toBe(false);
    await t.importJson([{ ...k, nonce: "99999999999999999997", timestamp: "2026-01-01T00:00:04Z" }]);
    expect((await t.call<IntegrityReport>("GET", "/api/integrity")).findings.some((f) => f.check === "nonce_reset")).toBe(true);
  });
});

describe("G-08 Import: a failed chunk left its rolled-back rows counted", () => {
  it("after a failed chunk the counters equal the committed rows (none)", async () => {
    const t = await fresh();
    const real = t.db.sql.batch.bind(t.db.sql);
    t.db.sql.batch = async () => {
      throw new Error("disk full (simulated)");
    };
    const job = await t.importJson(Array.from({ length: 5 }, (_, i) => ({ game: "crash", roundId: `r${i}`, serverSeed: S, clientSeed: C })));
    t.db.sql.batch = real;
    expect(job.status).toBe("failed");
    const stored = await t.db.countRounds();
    expect(stored).toBe(0);
    expect(job.stored).toBe(stored);
    expect(job.processed).toBe(stored);
  });
});

describe("G-09 Standalone scripts: unsupported versions and evidence limitations", () => {
  it("a record with an unimplemented version produces a script that refuses instead of substituting v2", async () => {
    const t = await fresh();
    await t.importJson([{ game: "keno", serverSeed: S, clientSeed: C, nonce: "1", algorithmVersion: "hmac_sha256_v3", difficulty: "CLASSIC" }]);
    const { rounds } = await t.call<{ rounds: { id: number; outcomeStatus: string }[] }>("GET", "/api/rounds");
    expect(rounds[0].outcomeStatus).toBe("unsupported_version");
    const file = join(tmp, "unsupported.mjs");
    writeFileSync(file, await t.call<string>("GET", `/api/rounds/${rounds[0].id}/script`));
    const run = spawnSync(process.execPath, [file], { encoding: "utf8", cwd: tmp });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/"hmac_sha256_v3" is not implemented/);
    expect(run.stdout).toBe("");
  });
  it("a reproduced round prints the limitations and labels the commitment check a candidate", async () => {
    const t = await fresh();
    const { savedId } = await t.call<{ savedId: number }>("POST", "/api/verify", {
      save: true,
      input: { game: "crash", serverSeed: S, clientSeed: C, reported: { multiplier: 1.25 }, commitment: "AB".repeat(32) },
    });
    const file = join(tmp, "crash.mjs");
    writeFileSync(file, await t.call<string>("GET", `/api/rounds/${savedId}/script`));
    const run = spawnSync(process.execPath, [file], { encoding: "utf8", cwd: tmp });
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out).toMatchObject({ agreesWithLab: true, matchesRecorded: true, commitmentCandidate: { equalsSupplied: false } });
    expect(out.labStatuses.timing).toBe("publication_timing_unverified");
    expect(out.limitations.join(" ")).toMatch(/not that the seeds were fixed before the round/);
    expect(out.meaning).toMatch(/does not prove/);
  });
});

describe("G-10 JSON export: evidence limitations were missing", () => {
  it("the JSON export carries the same limitations as the HTML/PDF reports", async () => {
    const t = await fresh();
    await t.call("POST", "/api/verify", { save: true, input: { game: "crash", serverSeed: S, clientSeed: C } });
    const exp = await t.call<{ limitations: string[] }>("GET", "/api/export?format=json");
    expect(exp.limitations.some((l) => /Keno payout tables are not verified/.test(l))).toBe(true);
  });
});

describe("G-11 Resource limits: oversized list validation exhausted memory", () => {
  it("non-import routes refuse bodies over the request limit before parsing", async () => {
    const t = await fresh();
    const big = JSON.stringify({ input: { game: "crash", serverSeed: "a", clientSeed: "b", source: "x".repeat(5 * 1024 * 1024) } });
    const res = await t.app.inject({ method: "POST", url: "/api/verify", payload: big, headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(413);
  });
  it("imports still accept large files", async () => {
    const t = await fresh();
    const row = `crash,${"s".repeat(4000)},${C}\n`;
    const text = "game,serverSeed,clientSeed\n" + row.repeat(Math.ceil((5 * 1024 * 1024) / row.length));
    const res = await t.app.inject({ method: "POST", url: "/api/import?wait=1", payload: { text, format: "csv" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().job).toMatchObject({ status: "completed", rejected: 0 });
  });
  it("an over-long list of invalid values yields one length error, not one issue per element", async () => {
    const t = await fresh();
    const input = { game: "keno", serverSeed: S, clientSeed: C, nonce: "1", algorithmVersion: "v2", difficulty: "LOW", selectedNumbers: Array(200_000).fill("x") };
    const started = performance.now();
    const { result } = await t.call<{ result: { errors: { field: string; message: string }[] } }>("POST", "/api/verify", { input });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.errors).toEqual([{ field: "selectedNumbers", message: "at most 100 values" }]);
  });
});
