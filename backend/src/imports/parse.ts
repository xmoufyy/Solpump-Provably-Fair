/**
 * Parsers for historical round imports (CSV, JSON, JSONL, pasted text).
 * Each row is normalised independently so one malformed row never sinks the whole import.
 * Seed values are copied byte-for-byte: never trimmed, never re-cased.
 */
import { parseCardList } from "../games/blackjack.js";
import { gridSizeFromTileCount } from "../games/mines.js";

export type ImportFormat = "csv" | "json" | "jsonl" | "auto";

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

const camel = (k: string) => k.trim().replace(/[_\-\s]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());

function intList(v: unknown, field: string): number[] | null {
  if (v === undefined || v === null || v === "") return null;
  if (Array.isArray(v)) {
    return v.map((x) => {
      const n = typeof x === "number" ? x : Number(String(x).trim());
      if (!Number.isInteger(n)) throw new Error(`${field}: "${x}" is not an integer`);
      return n;
    });
  }
  const tokens = String(v).split(/[\s,;|]+/).filter(Boolean);
  return tokens.map((t) => {
    if (!/^-?\d+$/.test(t)) throw new Error(`${field}: "${t}" is not an integer`);
    return Number(t);
  });
}

function num(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(/x$/i, ""));
  if (!Number.isFinite(n)) throw new Error(`${field}: "${v}" is not a number`);
  return n;
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
    roundId: opt(r.roundId ?? r.id ?? r.gameId),
    serverSeed: r.serverSeed ?? r.revealedServerSeed,
    clientSeed: r.clientSeed ?? r.publicSeed,
    commitment: opt(r.commitment ?? r.serverSeedHash ?? r.hashedServerSeed),
    timestamp: opt(r.timestamp ?? r.time ?? r.createdAt),
    source: opt(r.source ?? r.evidenceSource),
    txSignature: opt(r.txSignature ?? r.signature),
  };
  if (r.nonce !== undefined && r.nonce !== null && r.nonce !== "") out.nonce = String(r.nonce);
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
      if (Array.isArray(src) && src.every((c) => typeof c === "object")) out.reported = { cards: src };
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
      out.mineCount = num(r.mineCount ?? r.mines ?? r.minesCount, "mine count") ?? undefined;
      const base = num(r.indexBase, "index base");
      out.indexBase = base ?? 0;
      out.clickedTiles = intList(r.clickedTiles ?? r.revealedTiles ?? r.selectedTiles, "clicked tiles");
      // A generic "outcome" column may hold either win/loss or the mine positions.
      const genericText = opt(generic)?.trim().toLowerCase() ?? null;
      const genericIsResult = genericText === "win" || genericText === "loss";
      const mines = intList(r.reportedMines ?? reportedObj.mines ?? r.minePositions ?? (genericIsResult ? null : generic), "reported mines");
      const res = opt(r.reportedResult ?? reportedObj.outcome ?? (genericIsResult ? genericText : null))?.trim().toLowerCase() ?? null;
      if (res !== null && res !== "win" && res !== "loss") throw new Error(`reported result must be "win" or "loss" (got "${res}")`);
      out.reported = mines || res ? { mines, outcome: res } : null;
      break;
    }
  }
  return out;
}

export function detectFormat(text: string): Exclude<ImportFormat, "auto"> {
  const t = text.trimStart();
  if (t.startsWith("[") || (t.startsWith("{") && /"rounds"\s*:/.test(t.slice(0, 2000)))) return "json";
  if (t.startsWith("{")) return "jsonl";
  return "csv";
}

export function parseImport(text: string, format: ImportFormat): { format: string; rows: ParsedRow[] } {
  const fmt = format === "auto" ? detectFormat(text) : format;
  const rows: ParsedRow[] = [];
  const push = (line: number, raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return rows.push({ line, error: "Record is not an object" });
    try {
      rows.push({ line, input: normalizeRecord(raw as Record<string, unknown>) });
    } catch (e) {
      rows.push({ line, error: (e as Error).message });
    }
  };

  if (fmt === "json") {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { format: fmt, rows: [{ line: 0, error: `Invalid JSON: ${(e as Error).message}` }] };
    }
    const list = Array.isArray(data) ? data : (data as { rounds?: unknown[] }).rounds;
    if (!Array.isArray(list)) return { format: fmt, rows: [{ line: 0, error: "JSON must be an array or { rounds: [...] }" }] };
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
