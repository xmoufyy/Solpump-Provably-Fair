import { expect, test, type Page } from "@playwright/test";

// Synthetic fixture values (fixtures/synthetic-test-vectors.json) — not real Solpump rounds.
const S = "SERVER_TEST_2026";
const C = "CLIENT_TEST_2026";

async function seeds(page: Page, nonce?: string) {
  await page.getByTestId("server-seed").fill(S);
  await page.getByTestId("client-seed").fill(C);
  if (nonce !== undefined) await page.getByTestId("nonce").fill(nonce);
}

test("sidebar lists every section", async ({ page }) => {
  await page.goto("/");
  for (const id of ["dashboard", "crash", "blackjack", "keno", "mines", "history", "batch", "integrity", "onchain", "hmac", "compare", "export", "settings"]) {
    await expect(page.getByTestId(`nav-${id}`)).toBeVisible();
  }
});

test("Crash reproduces 1.25x and reports a mismatch for a wrong multiplier", async ({ page }) => {
  await page.goto("/#/crash");
  await seeds(page);
  await page.getByTestId("verify-button").click();
  await expect(page.getByTestId("crash-multiplier")).toContainText("1.25");
  await expect(page.getByTestId("overall-status")).toContainText("Reconstructed only");
  await page.getByTestId("reported-multiplier").fill("3.10");
  await page.getByTestId("verify-button").click();
  await expect(page.getByTestId("outcome-status")).toContainText("Mismatch");
});

test("Blackjack card 1 is the King of Clubs", async ({ page }) => {
  await page.goto("/#/blackjack");
  await seeds(page);
  await page.getByTestId("card-count").fill("6");
  await page.getByTestId("reported-cards").fill("K♣");
  await page.getByTestId("verify-button").click();
  await expect(page.getByTestId("card-1")).toHaveAttribute("data-card", "K-clubs");
  await expect(page.locator('[data-testid^="card-"][data-card]')).toHaveCount(6);
  await expect(page.getByTestId("outcome-status")).toContainText("Match");
  await expect(page.getByTestId("overall-status")).toContainText("Result matches, commitment timing unproven");
});

test("Keno: 5 difficulties, board sizes, 1–10 picks and the fixture draw", async ({ page }) => {
  await page.goto("/#/keno");
  const board = page.getByTestId("keno-board");
  await expect(board).toHaveAttribute("data-tiles", "40");
  await expect(board.locator("button")).toHaveCount(40);

  // Extreme → 56 tiles; picking 56 then returning to Classic removes it
  await page.getByTestId("keno-difficulty").getByRole("radio", { name: "Extreme" }).click();
  await expect(board.locator("button")).toHaveCount(56);
  await page.getByTestId("keno-tile-56").click();
  await expect(page.getByTestId("pick-counter")).toHaveText("Selected Numbers: 1 / 10");
  await page.getByTestId("keno-difficulty").getByRole("radio", { name: "Classic" }).click();
  await expect(board.locator("button")).toHaveCount(40);
  await expect(page.getByTestId("pick-counter")).toHaveText("Selected Numbers: 0 / 10");

  for (const d of ["Low", "Medium", "High"]) {
    await page.getByTestId("keno-difficulty").getByRole("radio", { name: d }).click();
    await expect(board.locator("button")).toHaveCount(40);
  }
  await page.getByTestId("keno-difficulty").getByRole("radio", { name: "Classic" }).click();

  // every count 1..10, 11th rejected, deselect works
  for (let n = 1; n <= 10; n++) {
    await page.getByTestId(`keno-tile-${n * 3}`).click();
    await expect(page.getByTestId("pick-counter")).toHaveText(`Selected Numbers: ${n} / 10`);
  }
  await page.getByTestId("keno-tile-1").click();
  await expect(page.getByTestId("pick-counter")).toHaveText("Selected Numbers: 10 / 10");
  await page.getByTestId("keno-tile-30").click();
  await expect(page.getByTestId("pick-counter")).toHaveText("Selected Numbers: 9 / 10");
  await page.getByTestId("clear-selection").click();
  await expect(page.getByTestId("pick-counter")).toHaveText("Selected Numbers: 0 / 10");

  for (const n of [27, 35, 2, 40]) await page.getByTestId(`keno-tile-${n}`).click();
  await seeds(page, "1");
  await page.getByTestId("reported-draw").fill("27 35 20 8 1 29 37 2 19 10");
  await page.getByTestId("verify-button").click();
  await expect(page.getByTestId("calculated-draw")).toHaveText("27352081293721910");
  await expect(page.getByTestId("match-count")).toHaveText("3");
  await expect(page.getByTestId("keno-tile-27")).toHaveAttribute("data-state", "match");
  await expect(page.getByTestId("keno-tile-20")).toHaveAttribute("data-state", "win");
  await expect(page.getByTestId("keno-tile-40")).toHaveAttribute("data-state", "picked");
  await expect(page.getByTestId("outcome-status")).toContainText("Match");
});

test("Mines: five grids, mine controls, fixture placement, save to history", async ({ page }) => {
  await page.goto("/#/mines");
  const board = page.getByTestId("mines-board");
  for (const [label, tiles] of [["9", 9], ["25", 25], ["36", 36], ["49", 49], ["64", 64]] as const) {
    await page.getByTestId("mines-grid").getByRole("radio", { name: label, exact: true }).click();
    await expect(board.locator("button")).toHaveCount(tiles);
  }
  // 3x3: preset 10 disabled; max is 8; changing grid clamps
  await page.getByTestId("mines-grid").getByRole("radio", { name: "9", exact: true }).click();
  await expect(page.getByTestId("preset-10")).toBeDisabled();
  await page.getByTestId("mine-count").fill("50");
  await page.getByTestId("mine-count").blur();
  await expect(page.getByTestId("mine-count")).toHaveValue("8");
  await expect(page.getByTestId("mines-inc")).toBeDisabled();

  // 6x6 with 35 mines → exactly one safe tile
  await page.getByTestId("mines-grid").getByRole("radio", { name: "36", exact: true }).click();
  await page.getByTestId("mine-count").fill("35");
  await page.getByTestId("mine-count").blur();
  await seeds(page, "1");
  await page.getByTestId("verify-button").click();
  await expect(board.locator('[data-mine="true"]')).toHaveCount(35);
  await expect(board.locator('[data-mine="false"]')).toHaveCount(1);

  // fixture: 5x5, 3 mines → 0, 14, 22, reported 1-based
  await page.getByTestId("mines-grid").getByRole("radio", { name: "25", exact: true }).click();
  await page.getByTestId("preset-3").click();
  await page.getByTestId("index-base").selectOption("1");
  await page.getByTestId("reported-mines").fill("1 15 23");
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("calculated-mines")).toHaveText("0, 14, 22");
  await expect(page.getByTestId("outcome-status")).toContainText("Match");
  await expect(page.getByText(/Saved to history as record #\d+/)).toBeVisible();

  await page.goto("/#/history");
  await expect(page.getByTestId("history-table").locator("tbody tr")).toHaveCount(1);
  await page.getByTestId("history-table").locator("tbody tr").first().click();
  await expect(page.getByTestId("round-detail")).toContainText("Cryptographic trace");
});

test("Batch import keeps good rows, reports bad rows; dashboard and integrity update", async ({ page }) => {
  await page.goto("/#/batch");
  const csv = [
    "round_id,game,algorithm_version,server_seed,client_seed,nonce,difficulty,grid_size,mine_count,card_count,reported_outcome,source",
    `c1,crash,,${S},${C},,,,,,1.25,e2e`,
    `c2,crash,,${S},${C},,,,,,7.00,e2e`,
    `k1,keno,hmac_sha256_v2,${S},${C},1,CLASSIC,,,,27 35 20 8 1 29 37 2 19 10,e2e`,
    `k2,keno,,${S},${C},1,CLASSIC,,,,,e2e`,
    `broken,row`,
  ].join("\n");
  await page.getByTestId("import-text").fill(csv);
  await page.getByTestId("import-button").click();
  const res = page.getByTestId("import-result");
  await expect(res).toContainText("4 stored");
  await expect(page.getByTestId("job-status")).toHaveText("completed");
  await expect(res).toContainText("1 rejected");
  await expect(res).toContainText("Mismatch");
  await expect(res).toContainText("Invalid input");

  await page.goto("/#/dashboard");
  await expect(page.getByTestId("metrics")).toContainText("Mismatches");
  await page.goto("/#/integrity");
  await expect(page.getByTestId("findings")).toContainText("seed pair used");
});

test("HMAC inspector reproduces the crash digest", async ({ page }) => {
  await page.goto("/#/hmac");
  await page.getByTestId("hmac-key").fill(S);
  await page.getByTestId("hmac-part-0").fill(C);
  await page.getByTestId("hmac-run").click();
  await expect(page.getByTestId("hmac-output")).toContainText("34378d55b8ed0c40420731e1bf7cb2f12c8c40c04a00599582611ca61266b165");
});

test("exports download in all four formats", async ({ page, request }) => {
  for (const f of ["csv", "json", "html", "pdf"]) {
    const r = await request.get(`/api/export?format=${f}`);
    expect(r.ok()).toBeTruthy();
    expect((await r.body()).length).toBeGreaterThan(100);
  }
  await page.goto("/#/export");
  await expect(page.getByTestId("export-pdf")).toBeVisible();
});
