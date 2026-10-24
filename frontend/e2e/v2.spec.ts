import { expect, test, type Page } from "@playwright/test";

// Synthetic fixture values (fixtures/synthetic-test-vectors.json) — not real Solpump rounds.
const S = "SERVER_TEST_2026";
const C = "CLIENT_TEST_2026";
const ROUTES = ["dashboard", "crash", "blackjack", "keno", "mines", "history", "batch", "sessions", "integrity", "onchain", "hmac", "compare", "export", "settings"];

async function seeds(page: Page, nonce?: string) {
  await page.getByTestId("server-seed").fill(S);
  await page.getByTestId("client-seed").fill(C);
  if (nonce !== undefined) await page.getByTestId("nonce").fill(nonce);
}

test("every page renders without console errors and sets a title", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  for (const r of ROUTES) {
    await page.goto(`/#/${r}`);
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page).toHaveTitle(/Solpump Fairness Lab/);
  }
  expect(errors).toEqual([]);
});

test("server-down banner appears when the API is unreachable", async ({ page }) => {
  await page.route("**/api/health", (r) => r.abort());
  await page.goto("/#/crash");
  await expect(page.getByTestId("server-down")).toContainText("Cannot reach the Fairness Lab server");
});

test("keyboard: radio groups use arrow keys; Keno tiles toggle with Enter and Space", async ({ page }) => {
  await page.goto("/#/keno");
  await page.getByTestId("keno-difficulty").getByRole("radio", { name: "Classic" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("keno-difficulty").getByRole("radio", { name: "Low" })).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("keno-tile-7").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("keno-tile-7")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("keno-tile-7")).toHaveAttribute("aria-pressed", "false");
});

test("Crash: 1.254 is a mismatch and is displayed unrounded (F-01, F-09)", async ({ page }) => {
  await page.goto("/#/crash");
  await seeds(page);
  await page.getByTestId("reported-multiplier").fill("1.254");
  await page.getByTestId("verify-button").click();
  const row = page.getByTestId("comparison-table").locator("tr", { hasText: "Crash multiplier" });
  await expect(row).toHaveAttribute("data-status", "mismatch");
  await expect(row).toContainText("1.254x");
  await expect(page.getByTestId("overall-status")).toContainText("Mismatch");
});

test("Mines: 1-based report and clicked tiles keep provenance; outcome derived from clicks", async ({ page }) => {
  await page.goto("/#/mines");
  await page.getByTestId("mines-grid").getByRole("radio", { name: "25", exact: true }).click();
  await page.getByTestId("preset-3").click();
  await seeds(page, "1");
  await page.getByTestId("index-base").selectOption("1");
  await page.getByTestId("reported-mines").fill("1 15 23");
  await page.getByTestId("mine-tile-3").click(); // index 3 -> safe
  await page.getByTestId("mine-tile-14").click(); // index 14 -> mine
  await page.getByLabel("Original outcome").selectOption("loss");
  await page.getByTestId("verify-button").click();
  const table = page.getByTestId("comparison-table");
  await expect(table.locator("tr", { hasText: "Mine positions" })).toHaveAttribute("data-status", "match");
  await expect(table.locator("tr", { hasText: "Round outcome" })).toHaveAttribute("data-status", "match");
  await expect(page.getByTestId("mine-tile-14")).toHaveAttribute("aria-label", /mine, marked as clicked/);
  await page.getByTestId("mines-view").getByRole("radio", { name: "Safe" }).click();
  await expect(page.getByTestId("mine-tile-0")).toHaveClass(/opacity-25/);
});

test("Batch: a large import is uploaded in chunks and can be paused, resumed and cancelled", async ({ page }) => {
  const lines = ["round_id,game,server_seed,client_seed,reported_outcome,source"];
  for (let i = 0; i < 30000; i++) lines.push(`e2e-${i},crash,seed-${i},client,1.00,e2e bulk`);
  await page.goto("/#/batch");
  await page.getByTestId("import-file").setInputFiles({ name: "bulk.csv", mimeType: "text/csv", buffer: Buffer.from(lines.join("\n")) });
  await expect(page.getByTestId("file-summary")).toContainText("bulk.csv");
  await page.getByTestId("import-button").click();
  await page.getByTestId("job-pause").click();
  await expect(page.getByTestId("job-status")).toHaveText("paused");
  // the rest of the app stays usable while an import is open
  await page.getByTestId("job-resume").click();
  await expect(page.getByTestId("job-status")).toHaveText("running");
  await page.getByTestId("job-cancel").click();
  await expect(page.getByTestId("job-status")).toHaveText("cancelled", { timeout: 15000 });
  await expect(page.getByTestId("import-result")).toContainText("committed before cancelling are complete");
});

test("History: deep link opens the detail dialog; reproducibility, script and Escape", async ({ page, request }) => {
  const r = await request.post("/api/verify", { data: { save: true, input: { game: "keno", serverSeed: S, clientSeed: C, nonce: "1", algorithmVersion: "hmac_sha256_v2", difficulty: "EXTREME", roundId: "e2e-deep-link", source: "e2e" } } });
  const { savedId } = await r.json();
  await page.goto(`/#/history/${savedId}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("e2e-deep-link");
  await expect(page.getByTestId("reproduced")).toContainText("reproduces the stored outcome exactly");
  await expect(dialog.getByTestId("trace")).toContainText("Draw");
  const script = await request.get(`/api/rounds/${savedId}/script`);
  expect(script.ok()).toBeTruthy();
  expect(await script.text()).toContain("standalone reproduction script");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("History filters by outcome and the search treats % literally", async ({ page, request }) => {
  await request.post("/api/verify", { data: { save: true, input: { game: "crash", serverSeed: S, clientSeed: C, reported: { multiplier: 9.99 }, roundId: "e2e-mismatch", source: "e2e" } } });
  await page.goto("/#/history");
  await page.getByTestId("history-outcome").selectOption("mismatch");
  await expect(page.getByTestId("history-table")).toContainText("e2e-mismatch");
  await page.getByTestId("history-search").fill("%");
  await expect(page.getByTestId("history-total")).toHaveText("0 records (filtered)");
});

test("Seed Sessions groups rounds by seed pair", async ({ page }) => {
  await page.goto("/#/sessions");
  await expect(page.getByTestId("sessions")).toContainText(S);
});

test("phone width: no horizontal page overflow on the verifiers", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const r of ["crash", "blackjack", "keno", "mines", "history", "batch"]) {
    await page.goto(`/#/${r}`);
    await expect(page.locator("main h1")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, r).toBe(false);
  }
});
