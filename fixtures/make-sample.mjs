// Generates fixtures/sample-import-synthetic.csv from the INDEPENDENT reference implementation.
// All rows are SYNTHETIC (made-up seeds). One crash row and one mines row are deliberately wrong
// so the import shows how mismatches are reported.
import { writeFileSync } from "node:fs";
import * as ref from "../backend/tests/reference/official.mjs";

const rows = [["round_id", "game", "algorithm_version", "server_seed", "client_seed", "nonce", "difficulty", "selected_numbers", "grid_size", "mine_count", "clicked_tiles", "index_base", "card_count", "reported_outcome", "commitment", "timestamp", "source"]];
const S = "synthetic-server-seed-A", C = "synthetic-client-seed";
const day = (d) => `2026-10-${String(d).padStart(2, "0")}T12:00:00Z`;
const fmt = (n) => n.toFixed(2);
for (let i = 1; i <= 6; i++) {
  const pub = `public-seed-${i}`;
  let m = ref.verifyCrash(`crash-server-${i}`, pub);
  if (i === 6) m = m + 1; // deliberate mismatch
  rows.push([`crash-${i}`, "crash", "", `crash-server-${i}`, pub, "", "", "", "", "", "", "", "", fmt(m), "", day(i), "SYNTHETIC sample"]);
}
const card = (c) => `${c.label}${c.suit[0].toUpperCase()}`;
rows.push(["bj-1", "blackjack", "", "bj-server-1", "bj-client-1", "", "", "", "", "", "", "", "6", [1, 2, 3, 4, 5, 6].map((n) => card(ref.generateCard("bj-server-1", "bj-client-1", n))).join(" "), "", day(3), "SYNTHETIC sample"]);
let nonce = 0;
for (const v of ["hmac_sha256_v2", "seedrandom_v1"]) {
  for (const mode of ["CLASSIC", "LOW", "MEDIUM", "HIGH", "EXTREME"]) {
    nonce++;
    rows.push([`keno-${nonce}`, "keno", v, S, C, String(nonce), mode, "3 7 12 19 27", "", "", "", "", "", ref.kenoDraw(S, C, String(nonce), v, mode).join(" "), "", day(nonce), "SYNTHETIC sample"]);
  }
  for (const g of [3, 5, 6, 7, 8]) {
    nonce++;
    const count = Math.min(g * g - 1, g + 1);
    let mines = ref.minesPlacement(S, C, String(nonce), v, g, count);
    if (v === "seedrandom_v1" && g === 8) mines = [...mines.slice(1), (mines[0] + 1) % 64].filter((x, i, a) => a.indexOf(x) === i); // deliberate mismatch
    rows.push([`mines-${nonce}`, "mines", v, S, C, String(nonce), "", "", String(g), String(count), "", "0", "", mines.join(" "), "", day(nonce), "SYNTHETIC sample"]);
  }
}
const esc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
writeFileSync(new URL("./sample-import-synthetic.csv", import.meta.url), rows.map((r) => r.map(esc).join(",")).join("\n") + "\n");
console.log(`wrote ${rows.length - 1} rows`);
