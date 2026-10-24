/**
 * Regression tests for import-parsing defects found in the third audit (G-03 .. G-05).
 * Each test failed against the code before the fix.
 */
import { describe, expect, it } from "vitest";
import { openImport, parseImport } from "../../src/imports/parse.js";

const S = "SERVER_TEST_2026", C = "CLIENT_TEST_2026";
const one = (text: string, format: "csv" | "json" = "json") => parseImport(text, format).rows[0];
const json = (o: Record<string, unknown>) => JSON.stringify([o]);
const mines = { game: "mines", serverSeed: S, clientSeed: C, nonce: "1", algorithmVersion: "v2", gridSize: 5, mineCount: 3 };

describe("G-03 Import: blank or non-decimal values became numbers", () => {
  it("a blank list element is rejected instead of becoming tile #0", () => {
    expect(one(json({ ...mines, clickedTiles: ["", 3] })).error).toMatch(/clicked tiles: "" is not a whole number/);
    expect(one(json({ ...mines, clickedTiles: [" ", 3] })).error).toMatch(/not a whole number/);
  });
  it("a whitespace-only numeric cell is missing, not 0", () => {
    const row = one(`game,serverSeed,clientSeed,nonce,algorithmVersion,gridSize,mineCount,indexBase\nmines,${S},${C},1,v2,5,3, `, "csv");
    expect(row.input?.indexBase).toBe(0);
    const missing = one(`game,serverSeed,clientSeed,nonce,algorithmVersion,gridSize,mineCount\nmines,${S},${C},1,v2,5, `, "csv");
    expect(missing.input?.mineCount).toBeUndefined(); // the schema then reports "required", never a 0-mine board
  });
  it("hex, exponent and word numbers are rejected", () => {
    expect(one(json({ ...mines, gridSize: "0x5" })).error).toMatch(/not a decimal number/);
    expect(one(json({ game: "crash", serverSeed: S, clientSeed: C, multiplier: "1e0" })).error).toMatch(/not a decimal number/);
    expect(one(json({ ...mines, clickedTiles: ["0x1"] })).error).toMatch(/not a whole number/);
  });
  it("ordinary decimals and the x suffix still parse", () => {
    expect(one(json({ game: "crash", serverSeed: S, clientSeed: C, multiplier: "1.25x" })).input?.reported).toEqual({ multiplier: 1.25 });
    expect(one(json({ ...mines, clickedTiles: "1, 2;3" })).input?.clickedTiles).toEqual([1, 2, 3]);
  });
});

describe("G-04 Import: conflicting alias columns were resolved silently", () => {
  it("serverSeed and revealedServerSeed with different values reject the row", () => {
    const row = one(json({ game: "crash", serverSeed: "a", revealedServerSeed: "b", clientSeed: C }));
    expect(row.error).toMatch(/server seed: columns "serverSeed" and "revealedServerSeed" disagree/);
  });
  it("seeds differing only in whitespace are a conflict too (seeds are exact)", () => {
    expect(one(json({ game: "crash", serverSeed: "a", revealedServerSeed: "a ", clientSeed: C })).error).toMatch(/disagree/);
  });
  it("aliases with the same value are accepted", () => {
    const row = one(json({ game: "crash", serverSeed: S, revealedServerSeed: S, clientSeed: C, multiplier: 1.25, reportedMultiplier: "1.25" }));
    expect(row.error).toBeUndefined();
    expect(row.input?.serverSeed).toBe(S);
  });
  it("conflicting reported outcomes and commitments reject the row", () => {
    expect(one(json({ game: "crash", serverSeed: S, clientSeed: C, multiplier: 1.25, reportedMultiplier: 2 })).error).toMatch(/reported multiplier/);
    expect(one(json({ game: "crash", serverSeed: S, clientSeed: C, commitment: "aa", serverSeedHash: "bb" })).error).toMatch(/commitment/);
    expect(one(json({ ...mines, reportedMines: [0, 14, 22], minePositions: [0, 14, 23] })).error).toMatch(/reported mines/);
  });
  it("Mines grid size and tile count must agree", () => {
    expect(one(json({ ...mines, tileCount: 36 })).error).toMatch(/disagrees with tile count 36/);
    expect(one(json({ ...mines, tileCount: 25 })).error).toBeUndefined();
  });
  it("a missing seed is reported as required, not as a type error", () => {
    expect(one(json({ game: "crash", clientSeed: C })).input?.serverSeed).toBeUndefined();
  });
});

describe("G-05 Import: CSV structure errors", () => {
  const header = "game,serverSeed,clientSeed,reportedMultiplier";
  it("an unterminated quote rejects the file instead of swallowing every following row", () => {
    const src = openImport(`${header}\ncrash,"a,c1,1.25\ncrash,b,c2,1.5\ncrash,d,c3,2\n`, "csv");
    const rows = [...src.rows];
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toMatch(/opened on line 2 is never closed/);
  });
  it("a quote inside an unquoted field is literal and does not desynchronise the record count", () => {
    const src = openImport(`${header}\ncrash,a"b,c,1.25\ncrash,b,c,1.5\n`, "csv");
    expect(src.total).toBe(2);
    expect([...src.rows].map((r) => r.raw?.serverSeed)).toEqual(['a"b', "b"]);
  });
  it("duplicate column names reject the file", () => {
    const rows = [...openImport(`game,serverSeed,server_seed,clientSeed\ncrash,a,b,c\n`, "csv").rows];
    expect(rows[0].error).toMatch(/Columns "serverSeed" and "server_seed" name the same field/);
  });
  it("trailing unnamed columns are still accepted", () => {
    expect([...openImport(`${header},,\ncrash,a,c,1.25,,\n`, "csv").rows][0].raw?.serverSeed).toBe("a");
  });
  it("row errors cite the physical line, even after blank lines and multi-line quoted fields", () => {
    const text = `${header}\r\n\r\ncrash,"multi\r\nline seed",c,1.25\r\ncrash,a,c\r\n`;
    const rows = [...openImport(text, "csv").rows];
    expect(rows[0].raw?.serverSeed).toBe("multi\r\nline seed");
    expect(rows[0].line).toBe(3);
    expect(rows[1]).toMatchObject({ line: 5, error: "Expected 4 columns, found 3" });
  });
});
