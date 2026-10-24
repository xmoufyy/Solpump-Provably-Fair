// Loads the bundled Vercel function the way Vercel's runtime does: without Node's require(esm) support.
// A CommonJS dependency that require()s an ES module loads fine locally but crashes every request on
// Vercel (FUNCTION_INVOCATION_FAILED), so this must fail here first.
// Run: node --no-experimental-require-module scripts/check-vercel-bundle.mjs   (after `npm run build:api`)
try {
  const mod = await import(new URL("../api/index.mjs", import.meta.url).href);
  if (typeof mod.default !== "function") throw new Error("api/index.mjs has no default handler export");
  console.log("Vercel function bundle loads without require(esm).");
} catch (e) {
  console.error(`Vercel function bundle failed to load: ${e.code ?? ""} ${e.message}`);
  process.exit(1);
}
