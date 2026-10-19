// Times each integrity check's SQL on a synthetic database (diagnostic tool for docs/PERFORMANCE_REPORT.md).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { buildApp } from "../src/api/app.js";
import { FairnessDb } from "../src/database/db.js";
import { runIntegrityAudit } from "../src/auditing/integrity.js";

const n = Number(process.argv[2] ?? 10000);
const dir = mkdtempSync(join(tmpdir(), "sfl-prof-"));
const { app, db } = await buildApp({ db: new FairnessDb(join(dir, "p.db")) });
const lines = ["round_id,game,algorithm_version,server_seed,client_seed,nonce,difficulty,timestamp,source,commitment"];
for (let i = 0; i < n; i++) lines.push(`r${i},keno,hmac_sha256_v2,srv${i % 500},cli${i % 97},${i},CLASSIC,2026-10-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z,bench,${i % 3 ? "" : "ab".repeat(32)}`);
await app.inject({ method: "POST", url: "/api/import?wait=1", payload: { text: lines.join("\n"), format: "csv" } });
const orig = db.db.prepare.bind(db.db);
const timings: [number, string][] = [];
(db.db as any).prepare = (sql: string) => {
  const st = orig(sql);
  const wrap = (fn: "all" | "get") => (...a: unknown[]) => {
    const t = performance.now();
    const r = (st as any)[fn](...a);
    timings.push([performance.now() - t, sql.replace(/\s+/g, " ").slice(0, 110)]);
    return r;
  };
  return { all: wrap("all"), get: wrap("get") };
};
const t0 = performance.now();
runIntegrityAudit(db.db);
console.log(`total ${Math.round(performance.now() - t0)} ms for ${n} rows`);
for (const [ms, sql] of timings.sort((a, b) => b[0] - a[0]).slice(0, 6)) console.log(`${Math.round(ms).toString().padStart(7)} ms  ${sql}`);
await app.close();
(db.db as any).prepare = orig;
db.db.close();
rmSync(dir, { recursive: true, force: true });
