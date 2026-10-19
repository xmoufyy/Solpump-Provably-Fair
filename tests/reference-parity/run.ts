/** CLI: node --import tsx ../tests/reference-parity/run.ts  (prints a parity summary; exit 1 on divergence) */
import { runParity } from "./harness.js";

const t0 = Date.now();
const r = runParity();
console.log(`Reference parity - ${Object.values(r.casesByAlgo).reduce((a, b) => a + b, 0)} cases, ${r.comparisons} comparisons, ${Date.now() - t0} ms`);
console.log(`Python independent implementation: ${r.pythonAvailable ? `yes (Python ${r.pythonVersion})` : "NOT AVAILABLE - prod vs JS reference only"}`);
for (const [algo, n] of Object.entries(r.casesByAlgo)) console.log(`  ${algo.padEnd(10)} ${n} cases`);
if (r.divergences.length) {
  console.log(`\n${r.divergences.length} DIVERGENCE(S):`);
  for (const d of r.divergences.slice(0, 20)) console.log(`  [${d.case.algo} ${d.case.tag}] first divergent step "${d.step}": ${JSON.stringify(d.values).slice(0, 300)}`);
  process.exit(1);
}
console.log("\nNo divergences.");
if (!r.pythonAvailable) process.exit(2);
