/**
 * Reproducible performance benchmark.
 *   node --import tsx bench/bench.ts [--sizes 1000,10000,100000] [--out file.json]
 * Uses a throw-away database in the OS temp dir; never touches data/fairness-lab.db.
 * Rows are deterministic (no Math.random), so runs are comparable across code versions.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { buildApp } from "../src/api/app.js";
import { FairnessDb } from "../src/database/db.js";
import { verifyRound } from "../src/verification/engine.js";
// @ts-ignore - plain JS reference implementation (no types needed for the benchmark)
import * as ref from "../../tests/reference-parity/reference/official.mjs";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const sizes = arg("--sizes", "1000,10000,100000").split(",").map(Number);
const out = arg("--out", "");

const seed = (i: number, tag: string) => createHash("sha256").update(`${tag}:${i}`).digest("hex");
const MODES = ["CLASSIC", "LOW", "MEDIUM", "HIGH", "EXTREME"];
const GRIDS = [3, 5, 6, 7, 8];

function csvRows(n: number): string {
  const lines = ["round_id,game,algorithm_version,server_seed,client_seed,nonce,difficulty,selected_numbers,grid_size,mine_count,card_count,reported_outcome,timestamp,source"];
  for (let i = 0; i < n; i++) {
    const s = seed(i, "srv"), c = seed(i % 97, "cli").slice(0, 16), nonce = String(i), ts = new Date(Date.UTC(2026, 9, 1 + (i % 28))).toISOString();
    switch (i % 4) {
      case 0:
        lines.push(`r${i},crash,,${s},${c},,,,,,,${ref.verifyCrash(s, c).toFixed(2)},${ts},bench`);
        break;
      case 1: {
        const cards = [1, 2, 3, 4].map((k) => ref.generateCard(s, c, k)).map((x: { label: string; suit: string }) => x.label + x.suit[0].toUpperCase()).join(" ");
        lines.push(`r${i},blackjack,,${s},${c},,,,,,4,${cards},${ts},bench`);
        break;
      }
      case 2: {
        const v = i % 8 === 2 ? "seedrandom_v1" : "hmac_sha256_v2", mode = MODES[i % 5];
        lines.push(`r${i},keno,${v},${s},${c},${nonce},${mode},3 7 12 19 27,,,,${ref.kenoDraw(s, c, nonce, v, mode).join(" ")},${ts},bench`);
        break;
      }
      default: {
        const v = i % 8 === 3 ? "seedrandom_v1" : "hmac_sha256_v2", g = GRIDS[i % 5], m = 1 + (i % (g * g - 1));
        lines.push(`r${i},mines,${v},${s},${c},${nonce},,,${g},${m},,${ref.minesPlacement(s, c, nonce, v, g, m).join(" ")},${ts},bench`);
      }
    }
  }
  return lines.join("\n");
}

const results: Record<string, unknown> = { node: process.version, platform: process.platform, date: new Date().toISOString() };

// 1. raw verifier throughput (includes trace generation, as the API does)
const opts = { commitmentScheme: "unconfirmed" as const, mode: "manual" as const };
const samples: Record<string, unknown> = {
  crash: { game: "crash", serverSeed: seed(1, "a"), clientSeed: "c" },
  blackjack: { game: "blackjack", serverSeed: seed(1, "a"), clientSeed: "c", cardCount: 10 },
  keno: { game: "keno", serverSeed: seed(1, "a"), clientSeed: "c", nonce: "1", algorithmVersion: "hmac_sha256_v2", difficulty: "EXTREME", selectedNumbers: [1, 2, 3] },
  mines_8x8_63: { game: "mines", serverSeed: seed(1, "a"), clientSeed: "c", nonce: "1", algorithmVersion: "hmac_sha256_v2", gridSize: 8, mineCount: 63 },
};
const throughput: Record<string, number> = {};
for (const [k, input] of Object.entries(samples)) {
  for (let i = 0; i < 200; i++) verifyRound(input, opts); // warm-up
  const N = 3000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) verifyRound(input, opts);
  throughput[k] = Math.round(N / ((performance.now() - t0) / 1000));
}
results.verifyPerSecond = throughput;
console.log("verify/s", throughput);

// 2. import + query timings
const imports: unknown[] = [];
for (const n of sizes) {
  const dir = mkdtempSync(join(tmpdir(), "sfl-bench-"));
  const dbPath = join(dir, "bench.db");
  const { app, db } = await buildApp({ db: await FairnessDb.open(dbPath) });
  const text = csvRows(n);
  global.gc?.();
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
  // Responsiveness: a 20 ms timer records how late it fires (= longest event-loop stall),
  // and a /api/health request is issued on every tick to measure what a user would wait.
  let lastTick = performance.now();
  let maxStall = 0;
  let probeMax = 0;
  let probes = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    maxStall = Math.max(maxStall, now - lastTick - 20);
    lastTick = now;
    const t = performance.now();
    void app.inject({ url: "/api/health" }).then(() => {
      probeMax = Math.max(probeMax, performance.now() - t);
      probes++;
    });
  }, 20);
  const t0 = performance.now();
  const res = await app.inject({ method: "POST", url: "/api/import?wait=1", payload: { text, format: "csv" } });
  const importMs = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 60)); // let the lag timer observe the end of any stall
  clearInterval(tick);
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  const body = res.json();
  const stored = Array.isArray(body.stored) ? body.stored.length : body.stored ?? body.job?.stored;

  const time = async (url: string) => {
    const t = performance.now();
    const r = await app.inject({ url });
    return { ms: Math.round(performance.now() - t), status: r.statusCode, bytes: r.rawPayload.length };
  };
  const q = {
    stats: await time("/api/stats"),
    integrity: await time("/api/integrity"),
    historyPage: await time("/api/rounds?limit=50"),
    historySearch: await time("/api/rounds?limit=50&q=r123"),
    historyFilter: await time("/api/rounds?limit=50&status=mismatch"),
    exportCsv: await time("/api/export?format=csv"),
  };
  await app.close();
  db.close();
  const dbBytes = statSync(dbPath).size + (() => { try { return statSync(dbPath + "-wal").size; } catch { return 0; } })();
  const row = { rows: n, csvBytes: text.length, stored, importMs: Math.round(importMs), rowsPerSecond: Math.round(n / (importMs / 1000)), peakRssDeltaMB: Math.round((peak - rss0) / 1e6), maxEventLoopStallMs: Math.round(Math.max(maxStall, 0)), healthProbeMaxMs: Math.round(probeMax), healthProbes: probes, dbMB: +(dbBytes / 1e6).toFixed(1), queries: q };
  console.log(JSON.stringify(row));
  imports.push(row);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* libSQL can hold the file until garbage collection on Windows */
  }
}
results.imports = imports;
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
