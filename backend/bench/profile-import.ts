// CPU profile of a 20k-row import (diagnostic tool; writes a .cpuprofile summary to stdout)
import { Session } from "node:inspector/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildApp } from "../src/api/app.js";
import { FairnessDb } from "../src/database/db.js";

const dir = mkdtempSync(join(tmpdir(), "sfl-pi-"));
const { app, db } = await buildApp({ db: await FairnessDb.open(join(dir, "p.db")) });
const lines = ["round_id,game,algorithm_version,server_seed,client_seed,nonce,grid_size,mine_count,reported_outcome,source"];
for (let i = 0; i < 20000; i++) lines.push(`r${i},mines,hmac_sha256_v2,${createHash("sha256").update(String(i)).digest("hex")},cli,${i},5,3,0 1 2,bench`);
const s = new Session();
s.connect();
await s.post("Profiler.enable");
await s.post("Profiler.start");
const t = Date.now();
await app.inject({ method: "POST", url: "/api/import?wait=1", payload: { text: lines.join("\n"), format: "csv" } });
console.log("import ms", Date.now() - t);
const { profile } = await s.post("Profiler.stop");
const self = new Map<string, number>();
const dt = profile.timeDeltas ?? [];
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
(profile.samples ?? []).forEach((id, i) => {
  const n = byId.get(id)!;
  const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split(/[\/]/).slice(-2).join("/")}:${n.callFrame.lineNumber}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
});
const total = [...self.values()].reduce((a, b) => a + b, 0);
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`);
await app.close();
db.close();
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* libSQL can hold the file until garbage collection on Windows; it stays in the temp folder */
}
