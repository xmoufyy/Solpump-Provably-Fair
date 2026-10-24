#!/usr/bin/env node
/**
 * Runs every local quality gate and prints an honest summary: PASS / FAIL / SKIP per check.
 * A check is SKIPPED (never silently passed) when a prerequisite is missing, e.g. Python for
 * the independent implementation or the Playwright browser.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";
const results = [];

function run(name, cmd, args, { skipIf, parse } = {}) {
  if (skipIf) {
    const reason = skipIf();
    if (reason) {
      results.push({ name, status: "SKIP", detail: reason, ms: 0 });
      console.log(`\n=== ${name}: SKIPPED (${reason})`);
      return;
    }
  }
  console.log(`\n=== ${name}`);
  const t = Date.now();
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: isWin, maxBuffer: 256 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out.split("\n").slice(-12).join("\n"));
  results.push({ name, status: r.status === 0 ? "PASS" : "FAIL", detail: parse ? parse(out) : "", ms: Date.now() - t });
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const vitestCounts = (out) => {
  const m = stripAnsi(out).match(/Tests\s+(.*?)\s*\(/);
  return m ? m[1].trim() : "";
};
const python = () => {
  for (const c of ["python", "python3", "py"]) {
    const r = spawnSync(c, ["-c", "import sys;print(sys.version_info[0])"], { encoding: "utf8" }); // no shell: keeps -c intact
    if (r.status === 0 && r.stdout.trim() === "3") return null;
  }
  return "Python 3 not found - independent implementation not run";
};
const chromium = () => {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || (isWin ? join(process.env.LOCALAPPDATA ?? "", "ms-playwright") : join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright"));
  return existsSync(base) && readdirSync(base).some((d) => d.startsWith("chromium")) ? null : "Playwright Chromium not installed (npm exec -w frontend -- playwright install chromium)";
};

run("TypeScript (backend + frontend)", npm, ["run", "typecheck"]);
run("ESLint", npm, ["run", "lint"]);
run("Unit + reference-parity tests", npm, ["test"], { parse: vitestCounts });
run("Independent Python parity run", npm, ["run", "test:parity"], {
  skipIf: python,
  parse: (o) => (stripAnsi(o).match(/Reference parity - (.*?) ms/) ?? [])[1] ?? "",
});
run("Integration tests", npm, ["run", "test:integration"], { parse: vitestCounts });
run("Production build", npm, ["run", "build"]);
run("Vercel function bundle loads", npm, ["run", "check:vercel"]);
run("Browser tests (Playwright)", npm, ["run", "test:e2e"], {
  skipIf: chromium,
  parse: (o) => (stripAnsi(o).match(/(\d+ passed[^\n]*|\d+ failed[^\n]*)/) ?? [])[1] ?? "",
});
run("Dependency audit (npm audit)", npm, ["audit", "--omit=optional"], {
  parse: (o) => (stripAnsi(o).match(/found \d+ vulnerabilities|\d+ vulnerabilit[^\n]*/) ?? [])[0] ?? "",
});

const pad = (s, n) => String(s).padEnd(n);
const lines = ["", "SUMMARY", "-------", ...results.map((r) => `${pad(r.status, 5)} ${pad(r.name, 34)} ${pad(`${(r.ms / 1000).toFixed(1)}s`, 8)} ${r.detail}`)];
const failed = results.filter((r) => r.status === "FAIL").length;
const skipped = results.filter((r) => r.status === "SKIP").length;
lines.push("", `${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped  (${new Date().toISOString()}, Node ${process.version}, ${process.platform})`);
console.log(lines.join("\n"));
mkdirSync("docs", { recursive: true });
writeFileSync("docs/AUDIT_RESULTS.txt", lines.join("\n").trimStart() + "\n");
process.exit(failed ? 1 : 0);
