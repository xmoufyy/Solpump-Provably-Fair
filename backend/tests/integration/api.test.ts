import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import { FairnessDb } from "../../src/database/db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sfl-"));
const dbPath = join(dir, "test.db");
let ctx: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  ctx = await buildApp({ db: new FairnessDb(dbPath) });
});
afterAll(async () => {
  await ctx.app.close();
  ctx.db.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const S = "SERVER_TEST_2026", C = "CLIENT_TEST_2026";

/** v2: imports run as jobs; ?wait=1 returns the finished job, rows are listed by batch id. */
async function importAndList(text: string, format: string) {
  const { job } = (await ctx.app.inject({ method: "POST", url: "/api/import?wait=1", payload: { text, format } })).json();
  const rows = (await ctx.app.inject({ url: `/api/rounds?batch=${job.id}&limit=500` })).json().rounds.reverse();
  return { job, stored: rows.map((r: { roundId: string; outcomeStatus: string }) => ({ roundId: r.roundId, outcome: r.outcomeStatus })) };
}

describe("API integration", () => {
  it("POST /api/verify reconstructs Keno and saves it", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/verify",
      payload: {
        save: true,
        input: { game: "keno", serverSeed: S, clientSeed: C, nonce: "1", algorithmVersion: "hmac_sha256_v2", difficulty: "CLASSIC", selectedNumbers: [27, 35, 5] },
      },
    });
    const body = res.json();
    expect(body.result.calculated.drawn).toEqual([27, 35, 20, 8, 1, 29, 37, 2, 19, 10]);
    expect(body.result.calculated.matchCount).toBe(2);
    expect(body.savedId).toBeGreaterThan(0);
  });

  it("imports mixed CSV without losing good rows when one row is malformed", async () => {
    const csv = [
      "round_id,game,algorithm_version,server_seed,client_seed,nonce,difficulty,grid_size,mine_count,card_count,reported_outcome,source",
      `c1,crash,,${S},${C},,,,,,1.25,test`,
      `c2,crash,,${S},${C},,,,,,9.99,test`,
      `k1,keno,hmac_sha256_v2,${S},${C},1,CLASSIC,,,,27 35 20 8 1 29 37 2 19 10,test`,
      `m1,mines,hmac_sha256_v2,${S},${C},1,,5,3,,0 14 22,test`,
      `b1,blackjack,,${S},${C},,,,,1,KC,test`,
      `bad,keno,hmac_sha256_v2,${S},${C},1,CLASSIC,,,,1 2 x,test`,
      `short,row`,
    ].join("\n");
    const body = await importAndList(csv, "csv");
    expect(body.stored.map((s: any) => [s.roundId, s.outcome])).toEqual([
      ["c1", "match"],
      ["c2", "mismatch"],
      ["k1", "match"],
      ["m1", "match"],
      ["b1", "match"],
    ]);
    expect(body.job.rejected).toBe(2);
    expect(body.job.errors.map((e: any) => e.line)).toEqual([7, 8]);
  });

  it("JSONL import with a broken line keeps the valid ones", async () => {
    const text = `{"game":"crash","serverSeed":"${S}","clientSeed":"${C}","roundId":"j1"}\n{not json}\n`;
    const body = await importAndList(text, "auto");
    expect(body.job.format).toBe("jsonl");
    expect(body.stored[0].outcome).toBe("missing_comparison");
    expect(body.job.rejected).toBe(1);
  });

  it("history persists across app restarts (same db file)", async () => {
    const before = (await ctx.app.inject({ url: "/api/rounds" })).json().total;
    const again = await buildApp({ db: new FairnessDb(dbPath) });
    const after = (await again.app.inject({ url: "/api/rounds" })).json().total;
    await again.app.close();
    again.db.db.close();
    expect(after).toBe(before);
    expect(after).toBeGreaterThan(0);
  });

  it("stats, integrity and reverify work", async () => {
    const stats = (await ctx.app.inject({ url: "/api/stats" })).json();
    expect(stats.metrics.mismatches).toBeGreaterThanOrEqual(1);
    const integ = (await ctx.app.inject({ url: "/api/integrity" })).json();
    // c1 (1.25x) and c2 (9.99x) share one Crash seed pair: two different results cannot both be true
    expect(integ.findings.find((f: any) => f.check.startsWith("seed_pair_reuse"))).toMatchObject({ check: "seed_pair_reuse_conflicting_outcomes", kind: "contradiction" });
    const { rounds } = (await ctx.app.inject({ url: "/api/rounds?limit=1" })).json();
    const rv = (await ctx.app.inject({ method: "POST", url: `/api/rounds/${rounds[0].id}/reverify` })).json();
    expect(rv.reproduced).toBe(true);
  });

  it("exports all four formats", async () => {
    for (const format of ["csv", "json", "html", "pdf"]) {
      const res = await ctx.app.inject({ url: `/api/export?format=${format}` });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.length).toBeGreaterThan(100);
    }
    const pdf = await ctx.app.inject({ url: "/api/export?format=pdf" });
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("settings round-trip and commitment scheme affects status", async () => {
    await ctx.app.inject({ method: "PUT", url: "/api/settings", payload: { commitmentScheme: "sha256_utf8_hex" } });
    const r = (
      await ctx.app.inject({ method: "POST", url: "/api/verify", payload: { input: { game: "crash", serverSeed: S, clientSeed: C, commitment: "ab".repeat(32) } } })
    ).json();
    expect(r.result.commitment.status).toBe("mismatch");
    await ctx.app.inject({ method: "PUT", url: "/api/settings", payload: { commitmentScheme: "unconfirmed" } });
  });

  it("synthetic sample import (built from the reference implementation) verifies with exactly the 2 planted mismatches", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../../../fixtures/sample-import-synthetic.csv", import.meta.url), "utf8");
    const body = await importAndList(text, "csv");
    expect(body.job.errors).toEqual([]);
    expect(body.stored).toHaveLength(27);
    const mism = body.stored.filter((s: any) => s.outcome === "mismatch").map((s: any) => s.roundId);
    expect(mism.sort()).toEqual(["crash-6", "mines-20"]);
    expect(body.stored.filter((s: any) => s.outcome === "match")).toHaveLength(25);
  });

  it("HMAC inspector reproduces the crash digest", async () => {
    const r = (await ctx.app.inject({ method: "POST", url: "/api/tools/hmac", payload: { key: S, parts: [{ value: C }] } })).json();
    expect(r.hmac).toBe("34378d55b8ed0c40420731e1bf7cb2f12c8c40c04a00599582611ca61266b165");
  });
});
