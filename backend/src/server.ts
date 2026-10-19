import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./api/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "localhost";

if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  // The API has no authentication by design (single-user local tool). Binding elsewhere exposes
  // every stored seed and the import/delete endpoints to the network.
  console.warn(`WARNING: binding to ${host}. Fairness Lab has no authentication; only do this on a trusted network.`);
}

const { app, db } = await buildApp({
  staticDir: resolve(here, "../../frontend/dist"),
  logger: process.env.SFL_LOG === "1",
  allowedHosts: (process.env.SFL_ALLOWED_HOSTS ?? "").split(",").filter(Boolean),
});
if (db.migration) {
  console.log(`Database upgraded from schema v${db.migration.from} to v${db.migration.to}.${db.migration.backup ? ` Backup: ${db.migration.backup}` : ""}`);
}
await app.listen({ port, host });
console.log(`Solpump Fairness Lab running at http://localhost:${port}`);
