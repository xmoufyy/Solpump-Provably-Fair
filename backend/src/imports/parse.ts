/**
 * Parsers for historical round imports (CSV, JSON, JSONL, pasted text).
 * Each row is normalised independently so one malformed row never sinks the whole import.
 * Seed values are copied byte-for-byte: never trimmed, never re-cased.
 * All imported data is untrusted: numbers that cannot be represented exactly are rejected,
 * never silently rounded.
 */
import { parseCardList } from "../../../shared/src/parsing.js";
import { gridSizeFromTileCount } from "../games/mines.js";

export type ImportFormat = "csv" | "json" | "jsonl" | "auto";

export interface RawRow {
  line: number;
  raw?: Record<string, unknown>;
  error?: string;
}
export interface ParsedRow {
  line: number;
  input?: Record<string, unknown>;
  error?: string;
}

/** RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). Values are not trimmed. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') (field += '"'), i++;
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === "") inQuotes = true;
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const camel = (k: string) =>
  k
    .replace(/^﻿/, "")
    .trim()
    .replace(/[_\-\s]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase());

function intList(v: unknown, field: string): number[] | null {
  if (v === undefined || v === null || v === "") return null;
  if (Array.isArray(v)) {
    if (v.length > 1000) throw new Error(`${field}: too many values`);
    return v.map((x) => {
      const n = typeof x === "number" ? x : Number(String(x).trim());
      if (!Number.isSafeInteger(n)) throw new Error(`${field}: "${x}" is not a whole number`);
      return n;
    });
  }
  const tokens = String(v).split(/[\s,;|]+/).filter(Boolean);
  if (tokens.length > 1000) throw new Error(`${field}: too many values`);
  return tokens.map((t) => {
    if (!/^-?\d+$/.test(t) || !Number.isSafeInteger(Number(t))) throw new Error(`${field}: "${t}" is not a whole number`);
    return Number(t);
  });
}

function num(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(/x$/i, ""));
  if (!Number.isFinite(n)) throw new Error(`${field}: "${v}" is not a number`);
  return n;
}

/**
 * Identifier-like fields (nonce, round id) must keep every digit. A JSON *number* beyond 2^53
 * has already lost digits inside JSON.parse, so it is rejected with an explanation (v1 bug F-05).
 */
function exactText(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) {
      throw new Error(`${field} ${v} is a JSON number that cannot be represented exactly (beyond 2^53 or not an integer); supply it as a string, e.g. "${field}": "…"`);
    }
    return String(v);
  }
  if (typeof v === "string") return v;
  throw new Error(`${field} must be text`);
}

const opt = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));

const VERSION_LABELS: Record<string, string> = {
  hmac_sha256_v2: "hmac_sha256_v2",
  v2: "hmac_sha256_v2",
  hmac: "hmac_sha256_v2",
  seedrandom_v1: "seedrandom_v1",
  v1: "seedrandom_v1",
  legacy: "seedrandom_v1",
};

/** Converts a flat or nested record (any key casing) into the verifier's RoundInput shape. */
export function normalizeRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) r[camel(k)] = v;
  const reportedObj = (typeof r.reported === "object" && r.reported !== null ? r.reported : {}) as Record<string, unknown>;

  const game = String(r.game ?? "").trim().toLowerCase();
  const out: Record<string, unknown> = {
    game,
    roundId: exactText(r.roundId ?? r.id ?? r.gameId, "roundId"),
    serverSeed: r.serverSeed ?? r.revealedServerSeed,
    clientSeed: r.clientSeed ?? r.publicSeed,
    commitment: opt(r.commitment ?? r.serverSeedHash ?? r.hashedServerSeed),
    timestamp: opt(r.timestamp ?? r.time ?? r.createdAt),
    source: opt(r.source ?? r.evidenceSource),
    txSignature: opt(r.txSignature ?? r.signature),
  };
  const nonce = exactText(r.nonce, "nonce");
  if (nonce !== null) out.nonce = nonce;
  if (r.algorithmVersion !== undefined && r.algorithmVersion !== "") {
    const label = String(r.algorithmVersion).trim().toLowerCase();
    out.algorithmVersion = VERSION_LABELS[label] ?? String(r.algorithmVersion);
  }

  const generic = r.reportedOutcome ?? r.outcome ?? r.result;
  switch (game) {
    case "crash": {
      const m = num(r.reportedMultiplier ?? reportedObj.multiplier ?? r.multiplier ?? generic, "reported multiplier");
      out.reported = m === null ? null : { multiplier: m };
      break;
    }
    case "blackjack": {
      const cc = num(r.cardCount ?? r.numberOfCards, "card count");
      if (cc !== null) out.cardCount = cc;
      const src = r.reportedCards ?? reportedObj.cards ?? r.cards ?? generic;
      if (Array.isArray(src) && src.every((c) => typeof c === "object" && c !== null)) out.reported = { cards: src };
      else if (src !== undefined && src !== null && src !== "") {
        const { cards, errors } = parseCardList(String(src));
        if (errors.length) throw new Error(errors.join("; "));
        out.reported = { cards };
      }
      if (out.cardCount === undefined) {
        const n = (out.reported as { cards?: unknown[] } | undefined)?.cards?.length;
        out.cardCount = n && n > 0 ? n : 10;
      }
      break;
    }
    case "keno": {
      out.difficulty = String(r.difficulty ?? r.risk ?? "").trim().toUpperCase() || undefined;
      out.selectedNumbers = intList(r.selectedNumbers ?? r.picks ?? r.selected, "selected numbers");
      const d = intList(r.reportedDraw ?? reportedObj.draw ?? r.drawn ?? r.winningNumbers ?? generic, "reported draw");
      out.reported = d ? { draw: d } : null;
      break;
    }
    case "mines": {
      const g = num(r.gridSize, "grid size");
      const tc = num(r.tileCount ?? r.tiles, "tile count");
      out.gridSize = g ?? (tc !== null ? gridSizeFromTileCount(tc) ?? -1 : undefined);
      // "mines" is ambiguous: a number is the mine count, a list is the reported positions (v1 bug F-08).
      const minesField = r.mines;
      const minesIsList = Array.isArray(minesField) || (typeof minesField === "string" && /[\s,;|]/.test(minesField.trim()));
      out.mineCount = num(r.mineCount ?? r.minesCount ?? (minesIsList ? undefined : minesField), "mine count") ?? undefined;
      const base = num(r.indexBase, "index base");
      out.indexBase = base ?? 0;
      out.clickedTiles = intList(r.clickedTiles ?? r.revealedTiles ?? r.selectedTiles, "clicked tiles");
      const genericText = opt(generic)?.trim().toLowerCase() ?? null;
      const genericIsResult = genericText === "win" || genericText === "loss";
      const mines = intList(
        r.reportedMines ?? reportedObj.mines ?? r.minePositions ?? (minesIsList ? minesField : undefined) ?? (genericIsResult ? null : generic),
        "reported mines",
      );
      if (out.mineCount === undefined && mines) out.mineCount = mines.length;
      const res = opt(r.reportedResult ?? reportedObj.outcome ?? (genericIsResult ? genericText : null))?.trim().toLowerCase() ?? null;
      if (res !== null && res !== "win" && res !== "loss") throw new Error(`reported result must be "win" or "loss" (got "${res}")`);
      out.reported = mines || res ? { mines, outcome: res } : null;
      break;
    }
  }
  return out;
}

export function detectFormat(text: string): Exclude<ImportFormat, "auto"> {
  const t = text.replace(/^﻿/, "").trimStart();
  if (t.startsWith("[")) return "json";
  if (t.startsWith("{")) {
    // A single (possibly pretty-printed) JSON document vs. one object per line (v1 bug F-07).
    try {
      JSON.parse(t);
      return "json";
    } catch {
      return "jsonl";
    }
  }
  return "csv";
}

/** Fast structural parse into raw records; per-row normalisation happens later (in chunks). */
export function parseImportRaw(input: string, format: ImportFormat): { format: Exclude<ImportFormat, "auto">; rows: RawRow[] } {
  const text = input.replace(/^﻿/, "");
  const fmt = format === "auto" ? detectFormat(text) : format;
  const rows: RawRow[] = [];
  const push = (line: number, raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) rows.push({ line, error: "Record is not an object" });
    else rows.push({ line, raw: raw as Record<string, unknown> });
  };

  if (fmt === "json") {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { format: fmt, rows: [{ line: 0, error: `Invalid JSON: ${(e as Error).message}` }] };
    }
    const list = Array.isArray(data) ? data : (data as { rounds?: unknown[] })?.rounds ?? (typeof data === "object" && data !== null ? [data] : null);
    if (!Array.isArray(list)) return { format: fmt, rows: [{ line: 0, error: "JSON must be an array, { rounds: [...] } or a single round object" }] };
    list.forEach((item, i) => push(i + 1, item));
  } else if (fmt === "jsonl") {
    text.split(/\r?\n/).forEach((l, i) => {
      if (!l.trim()) return;
      try {
        push(i + 1, JSON.parse(l));
      } catch (e) {
        rows.push({ line: i + 1, error: `Invalid JSON line: ${(e as Error).message}` });
      }
    });
  } else {
    const table = parseCsv(text);
    if (table.length < 2) return { format: fmt, rows: [{ line: 0, error: "CSV needs a header row and at least one data row" }] };
    const header = table[0].map((h) => h.trim());
    table.slice(1).forEach((cells, i) => {
      if (cells.length !== header.length) {
        rows.push({ line: i + 2, error: `Expected ${header.length} columns, found ${cells.length}` });
        return;
      }
      const obj: Record<string, string> = {};
      header.forEach((h, j) => (obj[h] = cells[j]));
      push(i + 2, obj);
    });
  }
  return { format: fmt, rows };
}

export function normalizeRow(row: RawRow): ParsedRow {
  if (!row.raw) return { line: row.line, error: row.error ?? "Unparseable row" };
  try {
    return { line: row.line, input: normalizeRecord(row.raw) };
  } catch (e) {
    return { line: row.line, error: (e as Error).message };
  }
}

/** Convenience: raw parse + normalisation of every row. */
export function parseImport(text: string, format: ImportFormat): { format: string; rows: ParsedRow[] } {
  const { format: fmt, rows } = parseImportRaw(text, format);
  return { format: fmt, rows: rows.map(normalizeRow) };
}
