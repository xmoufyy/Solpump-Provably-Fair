/** Chunked uploads: the browser cuts files at record boundaries without parsing or altering any value. */
import { describe, expect, it } from "vitest";
import { jsonArrayElements, planImport } from "../../../shared/src/imports.js";
import { openImport, normalizeRow } from "../../src/imports/parse.js";

/** Re-parses every chunk the way the server does and returns the raw records with their original line numbers. */
const reassemble = (text: string, maxChars: number) => {
  const plan = planImport(text, "auto", maxChars);
  const rows = plan.chunks.flatMap((c) => [...openImport(c.text, plan.format).rows].map((r) => ({ ...r, line: r.line + c.lineOffset })));
  return { plan, rows };
};

describe("planImport", () => {
  it("CSV: every chunk repeats the header, records are never split, line numbers map back", () => {
    const rows = Array.from({ length: 50 }, (_, i) => `r${i},crash,"seed ${i}, with comma",client,1.00`);
    rows[20] = 'r20,crash,"multi\nline ""quoted"" seed",client,1.00';
    const text = ["round_id,game,server_seed,client_seed,reported_outcome", ...rows].join("\n");
    const { plan, rows: out } = reassemble(text, 300);
    expect(plan.chunks.length).toBeGreaterThan(5);
    expect(plan.total).toBe(50);
    expect(out.map((r) => r.raw?.server_seed)).toEqual(Array.from({ length: 50 }, (_, i) => (i === 20 ? 'multi\nline "quoted" seed' : `seed ${i}, with comma`)));
    // physical lines in the original file: header is line 1, the multi-line record takes lines 22-23
    expect(out[0].line).toBe(2);
    expect(out[21].line).toBe(24);
    expect(out[49].line).toBe(52);
  });

  it("CSV: an unterminated quote stops the upload before anything is sent", () => {
    const plan = planImport('game,serverSeed\ncrash,"open\ncrash,b\n', "csv", 100);
    expect(plan.chunks).toEqual([]);
    expect(plan.error).toMatch(/opened on line 2 is never closed/);
  });

  it("JSON: numbers beyond 2^53 reach the server as written, so it can still reject them (F-05)", () => {
    const text = `[{"game":"keno","nonce":9007199254740993,"note":"a ] , { tricky \\" string"}, {"game":"crash"}]`;
    expect(jsonArrayElements(text)).toEqual([`{"game":"keno","nonce":9007199254740993,"note":"a ] , { tricky \\" string"}`, `{"game":"crash"}`]);
    const { rows } = reassemble(text, 10);
    expect(rows).toHaveLength(2);
    expect(normalizeRow(rows[0]).error).toMatch(/cannot be represented exactly/);
    expect(rows.map((r) => r.line)).toEqual([1, 2]);
  });

  it("JSONL: blank lines are skipped and numbering is preserved", () => {
    const text = '{"game":"crash","id":"a"}\n\n{"game":"crash","id":"b"}\n{bad json}\n';
    const { plan, rows } = reassemble(text, 30);
    expect(plan.total).toBe(3);
    expect(rows.map((r) => [r.line, r.error ? "error" : r.raw?.id])).toEqual([
      [1, "a"],
      [3, "b"],
      [4, "error"],
    ]);
  });

  it("a JSON document that is not an array is sent whole, or refused when too large", () => {
    expect(planImport('{"rounds":[{"game":"crash"}]}', "json", 1000).chunks).toHaveLength(1);
    expect(planImport(`{"rounds":[${'{"game":"crash"},'.repeat(100)}{}]}`, "json", 100).error).toMatch(/JSON array or JSONL/);
  });
});
