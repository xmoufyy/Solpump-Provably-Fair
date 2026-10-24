import { expect, test } from "@playwright/test";

// Synthetic fixture values (fixtures/synthetic-test-vectors.json) - not real Solpump rounds.
const S = "SERVER_TEST_2026";
const C = "CLIENT_TEST_2026";

test("invisible seed characters are named, and the value is still sent exactly", async ({ page }) => {
  await page.goto("/#/crash");
  const zw = String.fromCodePoint(0x200b);
  await page.getByTestId("server-seed").fill(`${S}${zw}`);
  await page.getByTestId("client-seed").fill(C);
  await expect(page.getByTestId("server-seed-warning")).toContainText("zero-width space (U+200B) at position 17");
  await expect(page.getByTestId("client-seed-warning")).toHaveCount(0);
  const [req] = await Promise.all([page.waitForRequest("**/api/verify"), page.getByTestId("verify-button").click()]);
  expect(req.postDataJSON().input.serverSeed).toBe(`${S}${zw}`);
});

test("each conclusion says what it shows and what evidence is still needed", async ({ page }) => {
  await page.goto("/#/crash");
  await page.getByTestId("server-seed").fill(S);
  await page.getByTestId("client-seed").fill(C);
  await page.getByLabel(/reported multiplier/i).fill("1.25");
  await page.getByTestId("verify-button").click();
  await expect(page.getByTestId("outcome-status-meaning")).toContainText("does not show the seeds were fixed before the round");
  await expect(page.getByTestId("commitment-status-meaning")).toContainText("Evidence still needed");
});

test("a saved-record notice is marked as belonging to the previous inputs after an edit", async ({ page }) => {
  await page.goto("/#/crash");
  await page.getByTestId("server-seed").fill(S);
  await page.getByTestId("client-seed").fill(C);
  await page.getByTestId("save-button").click();
  await expect(page.getByText(/Saved to history as record #\d+/)).toBeVisible();
  await page.getByTestId("client-seed").fill(`${C}x`);
  await expect(page.getByText(/previous inputs were saved as record #\d+; the current inputs are not saved/)).toBeVisible();
});

test("trace copy reports success, and failure when the clipboard is blocked", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/#/crash");
  await page.getByTestId("server-seed").fill(S);
  await page.getByTestId("client-seed").fill(C);
  await page.getByTestId("verify-button").click();
  await page.getByTestId("trace-copy").click();
  await expect(page.getByTestId("trace-copy-status")).toHaveText(/Copied \d+ steps/);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } }));
  await page.getByTestId("trace-copy").click();
  await expect(page.getByTestId("trace-copy-status")).toContainText("Copy failed");
});

test("History filters survive leaving the page and coming back, and can be cleared", async ({ page, request }) => {
  await request.post("/api/verify", { data: { save: true, input: { game: "crash", serverSeed: S, clientSeed: C, reported: { multiplier: 9.99 }, roundId: "qol-mismatch", source: "e2e" } } });
  await page.goto("/#/history");
  await page.getByTestId("history-outcome").selectOption("mismatch");
  await page.getByTestId("history-search").fill("qol-");
  await expect(page).toHaveURL(/#\/history\?.*outcome=mismatch.*q=qol-/);
  await page.goto("/#/crash");
  await page.goto("/#/history");
  await expect(page.getByTestId("history-outcome")).toHaveValue("mismatch");
  await expect(page.getByTestId("history-search")).toHaveValue("qol-");
  await expect(page.getByTestId("history-table")).toContainText("qol-mismatch");
  await page.getByTestId("history-clear").click();
  await expect(page.getByTestId("history-outcome")).toHaveValue("");
  await expect(page).toHaveURL(/#\/history$/);
});

test("no page scrolls sideways at phone width (375 px)", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const routes = ["dashboard", "crash", "blackjack", "keno", "mines", "history", "batch", "sessions", "integrity", "onchain", "hmac", "compare", "export", "settings"];
  const overflow: Record<string, number> = {};
  for (const r of routes) {
    await page.goto(`/#/${r}`);
    await expect(page.locator("main h1")).toBeVisible();
    overflow[r] = await page.locator("main").evaluate((m) => m.scrollWidth - m.clientWidth);
  }
  // a calculated result adds the status panel, boards and trace header
  for (const game of ["crash", "blackjack", "keno", "mines"]) {
    await page.goto(`/#/${game}`);
    await page.getByTestId("server-seed").fill(S);
    await page.getByTestId("client-seed").fill(C);
    if (game === "keno" || game === "mines") await page.getByTestId("nonce").fill("1");
    await page.getByTestId("verify-button").click();
    await expect(page.getByTestId("trace-copy")).toBeVisible();
    overflow[`${game} (with result)`] = await page.locator("main").evaluate((m) => m.scrollWidth - m.clientWidth);
  }
  expect(Object.entries(overflow).filter(([, px]) => px > 0)).toEqual([]);
});
