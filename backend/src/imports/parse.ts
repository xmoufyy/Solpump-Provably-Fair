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

/** RFC 4180 CSV records, yielded one at a time (quoted fields, escaped quotes, CRLF). Values are not trimmed. */
export function* iterateCsv(text: string): Generator<string[]> {
  for (const r of iterateCsvRecords(text)) yield r.cells;
}

/**
 * The CSV state machine. `line` is the physical (1-based) line on which each record starts, so error
 * messages point at the right place even with blank lines or quoted fields that span lines.
 * A quote opens a quoted field only at the start of a field; elsewhere it is literal.
 */
function* iterateCsvRecords(text: string): Generator<{ cells: string[]; line: number }> {
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        field += ch;
      }
    } else if (ch === '"' && field === "") inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (!(row.length === 1 && row[0] === "")) yield { cells: row, line: recordLine };
      row = [];
      field = "";
      recordLine = ++line;
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) yield { cells: row, line: recordLine };
  }
}

export function parseCsv(text: string): string[][] {
  return [...iterateCsv(text)];
}

/**
 * Exact number of non-empty CSV records, using the same quote rules as the parser, plus the line of a
 * quoted field that is never closed. Such a field would silently swallow every following row, so the
 * file is rejected instead of guessing where the records end.
 */
function scanCsv(text: string): { records: number; unterminatedLine: number | null } {
  let records = 0;
  let inQuotes = false;
  let atFieldStart = true;
  let empty = true;
  let line = 1;
  let quoteLine = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) line++;
    if (inQuotes) {
      if (c === 34) {
        if (text.charCodeAt(i + 1) === 34) i++;
        else inQuotes = false;
      }
      continue;
    }
    if (c === 34 && atFieldStart) {
      inQuotes = true;
      quoteLine = line;
      atFieldStart = false;
      empty = false;
    } else if (c === 10 || c === 13) {
      if (c === 13 && text.charCodeAt(i + 1) === 10) {
        i++;
        line++;
      }
      if (!empty) records++;
      empty = true;
      atFieldStart = true;
    } else {
      atFieldStart = c === 44;
      empty = false;
    }
  }
  if (inQuotes) return { records, unterminatedLine: quoteLine };
  return { records: empty ? records : records + 1, unterminatedLine: null };
}

const camel = (k: string) =>
  k
    .replace(/^﻿/, "")
    .trim()
    .replace(/[_\-\s]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase());

const isMissing = (v: unknown) => v === undefined || v === null || v === "";
const WHOLE = /^-?\d+$/;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/**
 * A list of whole numbers from a JSON array or "1, 2 3;4|5" text. Every element must be a whole number
 * written in decimal: a blank element is an error, never 0 (it would fabricate e.g. a clicked tile #0).
 */
function intList(v: unknown, field: string): number[] | null {
  if (isMissing(v)) return null;
  const tokens: unknown[] = Array.isArray(v) ? v : String(v).split(/[\s,;|]+/).filter(Boolean);
  if (tokens.length > 1000) throw new Error(`${field}: too many values`);
  return tokens.map((x) => {
    const n = typeof x === "number" ? x : typeof x === "string" && WHOLE.test(x.trim()) ? Number(x.trim()) : NaN;
    if (!Number.isSafeInteger(n)) throw new Error(`${field}: ${JSON.stringify(x) ?? String(x)} is not a whole number`);
    return n;
  });
}

/** A decimal number ("1.25", "1.25x"). Blank text is missing, never 0; hex, exponents and words are rejected. */
function num(v: unknown, field: string): number | null {
  if (isMissing(v)) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`${field}: "${v}" is not a number`);
    return v;
  }
  const text = typeof v === "string" ? v.trim() : null;
  if (text === "") return null;
  const t = text?.replace(/x$/i, "") ?? "";
  if (!DECIMAL.test(t)) throw new Error(`${field}: ${JSON.stringify(v) ?? String(v)} is not a decimal number`);
  return Number(t);
}

/**
 * Identifier-like fields (nonce, round id) must keep every digit. A JSON *number* beyond 2^53
 * has already lost digits inside JSON.parse, so it is rejected with an explanation (v1 bug F-05).
 */
function exactText(v: unknown, field: string): string | null {
  if (isMissing(v)) return null;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) {
      throw new Error(`${field} ${v} is a JSON number that cannot be represented exactly (beyond 2^53 or not an integer); supply it as a string, e.g. "${field}": "…"`);
    }
    return String(v);
  }
  if (typeof v === "string") return v;
  throw new Error(`${field} must be text`);
}

const opt = (v: unknown) => (isMissing(v) ? null : String(v));
const same = <T>(v: T) => v;

/**
 * Several column names are accepted for one field (e.g. serverSeed / revealedServerSeed). When a record
 * fills more than one of them with different values, which one is right is unknown: the row is rejected
 * instead of letting the first alias silently win and discarding conflicting evidence.
 */
function pick<T>(field: string, candidates: [name: string, value: unknown][], parse: (v: unknown) => T | null): T | null {
  let chosen: { name: string; value: T; key: string } | null = null;
  for (const [name, raw] of candidates) {
    if (isMissing(raw)) continue;
    const value = parse(raw);
    if (value === null) continue;
    const key = JSON.stringify(value) ?? String(value);
    if (!chosen) chosen = { name, value, key };
    else if (key !== chosen.key) {
      const show = (k: string) => (k.length > 60 ? `${k.slice(0, 57)}...` : k);
      throw new Error(`${field}: columns "${chosen.name}" and "${name}" disagree (${show(chosen.key)} vs ${show(key)}). Correct the record; the Lab does not choose between conflicting values.`);
    }
  }
  return chosen?.value ?? null;
}

const VERSION_LABELS: Record<string, string> = {
  hmac_sha256_v2: "hmac_sha256_v2",
  v2: "hmac_sha256_v2",
  hmac: "hmac_sha256_v2",
  seedrandom_v1: "seedrandom_v1",
  v1: "seedrandom_v1",
  legacy: "seedrandom_v1",
};

function parseCards(src: unknown): { label: string; suit: string }[] | null {
  if (Array.isArray(src) && src.every((c) => typeof c === "object" && c !== null)) return src as { label: string; suit: string }[];
  const { cards, errors } = parseCardList(String(src));
  if (errors.length) throw new Error(errors.join("; "));
  return cards;
}

/** Converts a flat or nested record (any key casing) into the verifier's RoundInput shape. */
export function normalizeRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) r[camel(k)] = v;
  const reportedObj = (typeof r.reported === "object" && r.reported !== null ? r.reported : {}) as Record<string, unknown>;
  const c = (...names: string[]): [string, unknown][] => names.map((n) => (n.startsWith("reported.") ? [n, reportedObj[n.slice(9)]] : [n, r[n]]));

  const game = String(r.game ?? "").trim().toLowerCase();
  const out: Record<string, unknown> = {
    game,
    roundId: pick("roundId", c("roundId", "id", "gameId"), (v) => exactText(v, "roundId")),
    // seeds are copied exactly (no trimming); a missing seed stays undefined so the schema reports it as required
    serverSeed: pick("server seed", c("serverSeed", "revealedServerSeed"), same) ?? undefined,
    clientSeed: pick("client seed", c("clientSeed", "publicSeed"), same) ?? undefined,
    commitment: pick("commitment", c("commitment", "serverSeedHash", "hashedServerSeed"), opt),
    timestamp: pick("timestamp", c("timestamp", "time", "createdAt"), opt),
    source: pick("source", c("source", "evidenceSource"), opt),
    txSignature: pick("txSignature", c("txSignature", "signature"), opt),
  };
  const nonce = exactText(r.nonce, "nonce");
  if (nonce !== null) out.nonce = nonce;
  if (!isMissing(r.algorithmVersion)) {
    const label = String(r.algorithmVersion).trim().toLowerCase();
    out.algorithmVersion = VERSION_LABELS[label] ?? String(r.algorithmVersion);
  }

  const genericNames = ["reportedOutcome", "outcome", "result"];
  switch (game) {
    case "crash": {
      const m = pick("reported multiplier", c("reportedMultiplier", "reported.multiplier", "multiplier", ...genericNames), (v) => num(v, "reported multiplier"));
      out.reported = m === null ? null : { multiplier: m };
      break;
    }
    case "blackjack": {
      const cc = pick("card count", c("cardCount", "numberOfCards"), (v) => num(v, "card count"));
      if (cc !== null) out.cardCount = cc;
      const cards = pick("reported cards", c("reportedCards", "reported.cards", "cards", ...genericNames), parseCards);
      if (cards !== null) out.reported = { cards };
      if (out.cardCount === undefined) out.cardCount = cards && cards.length > 0 ? cards.length : 10;
      break;
    }
    case "keno": {
      out.difficulty = pick("difficulty", c("difficulty", "risk"), (v) => String(v).trim().toUpperCase() || null) ?? undefined;
      out.selectedNumbers = pick("selected numbers", c("selectedNumbers", "picks", "selected"), (v) => intList(v, "selected numbers"));
      const d = pick("reported draw", c("reportedDraw", "reported.draw", "drawn", "winningNumbers", ...genericNames), (v) => intList(v, "reported draw"));
      out.reported = d ? { draw: d } : null;
      break;
    }
    case "mines": {
      const g = num(r.gridSize, "grid size");
      const tc = pick("tile count", c("tileCount", "tiles"), (v) => num(v, "tile count"));
      if (g !== null && tc !== null && g * g !== tc) throw new Error(`grid size ${g} (${g * g} tiles) disagrees with tile count ${tc}`);
      out.gridSize = g ?? (tc !== null ? gridSizeFromTileCount(tc) ?? -1 : undefined);
      // "mines" is ambiguous: a number is the mine count, a list is the reported positions (v1 bug F-08).
      const minesField = r.mines;
      const minesIsList = Array.isArray(minesField) || (typeof minesField === "string" && /[\s,;|]/.test(minesField.trim()));
      out.mineCount = pick("mine count", [...c("mineCount", "minesCount"), ["mines", minesIsList ? undefined : minesField]], (v) => num(v, "mine count")) ?? undefined;
      out.indexBase = num(r.indexBase, "index base") ?? 0;
      out.clickedTiles = pick("clicked tiles", c("clickedTiles", "revealedTiles", "selectedTiles"), (v) => intList(v, "clicked tiles"));
      const generic = c(...genericNames).filter(([, v]) => !isMissing(v));
      const isResult = (v: unknown) => ["win", "loss"].includes(String(v).trim().toLowerCase());
      const mines = pick(
        "reported mines",
        [...c("reportedMines", "reported.mines", "minePositions"), ["mines", minesIsList ? minesField : undefined], ...generic.filter(([, v]) => !isResult(v))],
        (v) => intList(v, "reported mines"),
      );
      if (out.mineCount === undefined && mines) out.mineCount = mines.length;
      const res = pick("reported result", [...c("reportedResult", "reported.outcome"), ...generic.filter(([, v]) => isResult(v))], (v) => String(v).trim().toLowerCase());
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

export interface ImportSource {
  format: Exclude<ImportFormat, "auto">;
  /** number of records the iterator will yield */
  total: number;
  rows: Iterable<RawRow>;
}

const asRaw = (line: number, raw: unknown): RawRow =>
  typeof raw !== "object" || raw === null || Array.isArray(raw) ? { line, error: "Record is not an object" } : { line, raw: raw as Record<string, unknown> };

/**
 * Opens an import lazily: CSV and JSONL records are parsed on demand (inside the importer's
 * time slices), so a large file never blocks the event loop in one piece and the whole file
 * is never held as parsed objects at once. JSON documents are parsed in one call (JSON.parse).
 */
export function openImport(input: string, format: ImportFormat): ImportSource {
  const text = input.replace(/^\uFEFF/, "");
  const fmt = format === "auto" ? detectFormat(text) : format;

  if (fmt === "json") {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { format: fmt, total: 1, rows: [{ line: 0, error: `Invalid JSON: ${(e as Error).message}` }] };
    }
    const list = Array.isArray(data) ? data : (data as { rounds?: unknown[] })?.rounds ?? (typeof data === "object" && data !== null ? [data] : null);
    if (!Array.isArray(list)) return { format: fmt, total: 1, rows: [{ line: 0, error: "JSON must be an array, { rounds: [...] } or a single round object" }] };
    return { format: fmt, total: list.length, rows: list.map((item, i) => asRaw(i + 1, item)) };
  }

  if (fmt === "jsonl") {
    const lines = text.split(/\r?\n/);
    return {
      format: fmt,
      total: lines.filter((l) => l.trim()).length,
      rows: (function* () {
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          try {
            yield asRaw(i + 1, JSON.parse(lines[i]));
          } catch (e) {
            yield { line: i + 1, error: `Invalid JSON line: ${(e as Error).message}` };
          }
        }
      })(),
    };
  }

  const { records, unterminatedLine } = scanCsv(text);
  if (unterminatedLine !== null) {
    return {
      format: fmt,
      total: 1,
      rows: [{ line: unterminatedLine, error: `A quoted field opened on line ${unterminatedLine} is never closed, so the rows after it cannot be separated reliably. Nothing was imported; close the quote (or escape it as "") and retry.` }],
    };
  }
  if (records < 2) return { format: fmt, total: 1, rows: [{ line: 0, error: "CSV needs a header row and at least one data row" }] };
  const first = iterateCsvRecords(text).next();
  const headerCells = first.done ? [] : first.value.cells.map((h) => h.trim());
  const seen = new Map<string, string>();
  for (const h of headerCells) {
    const key = camel(h);
    if (key === "") continue; // unnamed (e.g. trailing-comma) columns carry no field
    if (seen.has(key)) {
      return { format: fmt, total: 1, rows: [{ line: 1, error: `Columns "${seen.get(key)}" and "${h}" name the same field; one would silently overwrite the other. Remove or rename one.` }] };
    }
    seen.set(key, h);
  }
  return {
    format: fmt,
    total: records - 1,
    rows: (function* () {
      let header: string[] | null = null;
      for (const { cells, line } of iterateCsvRecords(text)) {
        if (!header) {
          header = headerCells;
          continue;
        }
        if (cells.length !== header.length) {
          yield { line, error: `Expected ${header.length} columns, found ${cells.length}` };
          continue;
        }
        const obj: Record<string, string> = {};
        for (let j = 0; j < header.length; j++) obj[header[j]] = cells[j];
        yield asRaw(line, obj);
      }
    })(),
  };
}

/** Eager variant (tests / small inputs). */
export function parseImportRaw(input: string, format: ImportFormat): { format: Exclude<ImportFormat, "auto">; rows: RawRow[] } {
  const src = openImport(input, format);
  return { format: src.format, rows: [...src.rows] };
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
