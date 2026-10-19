import { defineConfig } from "@playwright/test";
import { readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Fresh database for every e2e run (never touches the real data/fairness-lab.db).
// The config is re-evaluated in worker processes, so the path is fixed once via env.
const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
if (!process.env.SFL_E2E_DB) {
  try {
    for (const f of readdirSync(dataDir)) if (f.startsWith("e2e-")) rmSync(join(dataDir, f), { force: true });
  } catch {
    /* data dir may not exist yet, or an old file is still locked */
  }
  process.env.SFL_E2E_DB = join(dataDir, `e2e-${Date.now()}.db`);
}
const e2eDb = process.env.SFL_E2E_DB;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:8788", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  webServer: {
    command: "npm run start -w backend",
    cwd: "..",
    url: "http://127.0.0.1:8788/api/health",
    env: { PORT: "8788", SFL_DB_PATH: e2eDb },
    reuseExistingServer: false,
    timeout: 60000,
  },
});
