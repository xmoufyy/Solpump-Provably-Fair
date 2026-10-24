/**
 * Import file structure, shared by the server (parsing) and the browser (splitting large files into
 * chunks that fit a request). Pure functions: no Node or DOM APIs.
 *
 * Splitting never parses values: chunks are cut from the original text at record boundaries, so every
 * value (including JSON numbers beyond 2^53, which the server must see in order to reject them) reaches
 * the server exactly as written.
 */

/** U+FEFF byte-order mark that spreadsheet exports put in front of UTF-8 text */
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

export type ImportFormat = "csv" | "json" | "jsonl" | "auto";
export type ConcreteFormat = Exclude<ImportFormat, "auto">;

export interface CsvRecord {
  cells: string[];
  /** physical (1-based) line on which the record starts */
  line: number;
  /** offset of the record's first character */
  start: number;
  /** offset just after the record's line terminator (or the end of the text) */
  end: number;
}

/**
 * The CSV state machine (RFC 4180: quoted fields, escaped quotes, CRLF). Values are not trimmed.
 * `line` is the physical line on which each record starts, so error messages point at the right place
 * even with blank lines or quoted fields that span lines. A quote opens a quoted field only at the start
 * of a field; elsewhere it is literal.
 */
export function* iterateCsvRecords(text: string): Generator<CsvRecord> {
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let recordStart = 0;
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
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (!(row.length === 1 && row[0] === "")) yield { cells: row, line: recordLine, start: recordStart, end: i + 1 };
      row = [];
      field = "";
      recordLine = ++line;
      recordStart = i + 1;
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) yield { cells: row, line: recordLine, start: recordStart, end: text.length };
  }
}

/**
 * Exact number of non-empty CSV records, using the same quote rules as the parser, plus the line of a
 * quoted field that is never closed. Such a field would silently swallow every following row, so the
 * file is rejected instead of guessing where the records end.
 */
export function scanCsv(text: string): { records: number; unterminatedLine: number | null } {
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

export const unterminatedQuoteError = (line: number) =>
  `A quoted field opened on line ${line} is never closed, so the rows after it cannot be separated reliably. Nothing was imported; close the quote (or escape it as "") and retry.`;

export function detectFormat(text: string): ConcreteFormat {
  const t = text.replace(BOM, "").trimStart();
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

/**
 * Top-level elements of a JSON array as raw text slices (no value is parsed). Null when the text is not
 * a well-formed array at the top level, in which case it is sent whole and the server reports the error.
 */
export function jsonArrayElements(text: string): string[] | null {
  let i = text.search(/\S/);
  if (i < 0 || text[i] !== "[") return null;
  const elements: string[] = [];
  let depth = 0;
  let inString = false;
  let start = -1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") {
      depth++;
      if (depth === 1) {
        start = i + 1;
        continue;
      }
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        const last = text.slice(start, i).trim();
        if (last) elements.push(last);
        return text.slice(i + 1).trim() === "" ? elements : null;
      }
    } else if (c === "," && depth === 1) {
      elements.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

export interface ImportChunk {
  text: string;
  /** added to the line (record number for JSON) the server reports for this chunk, giving the line in the original file */
  lineOffset: number;
}
export interface ImportPlan {
  format: ConcreteFormat;
  /** number of records */
  total: number;
  chunks: ImportChunk[];
  /** set when the file cannot be split safely; nothing should be uploaded */
  error?: string;
}

/**
 * Cuts an import into chunks of at most about `maxChars` characters, each a valid file of the same
 * format on its own (CSV chunks repeat the header). A single record larger than the limit gets a chunk
 * of its own.
 */
export function planImport(input: string, format: ImportFormat, maxChars: number): ImportPlan {
  const text = input.replace(BOM, "");
  const fmt = format === "auto" ? detectFormat(text) : format;
  const chunks: ImportChunk[] = [];
  const group = <T>(items: T[], size: (t: T) => number, emit: (from: number, to: number) => void) => {
    let from = 0;
    let chars = 0;
    items.forEach((item, i) => {
      if (i > from && chars + size(item) > maxChars) {
        emit(from, i);
        from = i;
        chars = 0;
      }
      chars += size(item);
    });
    if (from < items.length) emit(from, items.length);
  };

  if (fmt === "csv") {
    const scan = scanCsv(text);
    if (scan.unterminatedLine !== null) return { format: fmt, total: 0, chunks: [], error: unterminatedQuoteError(scan.unterminatedLine) };
    const records = [...iterateCsvRecords(text)];
    if (records.length < 2) return { format: fmt, total: 0, chunks: [], error: "CSV needs a header row and at least one data row" };
    const [header, ...rows] = records;
    const headerText = text.slice(header.start, header.end).replace(/[^\r\n]$/, (c) => `${c}\n`);
    const headerLines = (headerText.match(/\r\n|\r|\n/g) ?? []).length;
    group(rows, (r) => r.end - r.start, (from, to) =>
      chunks.push({ text: headerText + text.slice(rows[from].start, rows[to - 1].end), lineOffset: rows[from].line - (headerLines + 1) }),
    );
    return { format: fmt, total: rows.length, chunks };
  }

  if (fmt === "jsonl") {
    const lines: { text: string; line: number }[] = [];
    text.split(/\r?\n/).forEach((l, i) => l.trim() && lines.push({ text: l, line: i + 1 }));
    group(lines, (l) => l.text.length + 1, (from, to) => {
      // keep blank lines out but preserve numbering through the offset of each chunk's first line
      const slice = lines.slice(from, to);
      const first = slice[0].line;
      const body: string[] = [];
      for (const l of slice) {
        while (first + body.length < l.line) body.push("");
        body.push(l.text);
      }
      chunks.push({ text: body.join("\n"), lineOffset: first - 1 });
    });
    return { format: fmt, total: lines.length, chunks };
  }

  const elements = jsonArrayElements(text);
  if (elements === null) {
    if (text.length > maxChars) {
      return { format: fmt, total: 0, chunks: [], error: "This JSON file is too large to upload in one piece and is not a plain array of rounds. Use a JSON array or JSONL (one round per line)." };
    }
    return { format: fmt, total: 1, chunks: [{ text, lineOffset: 0 }] };
  }
  group(elements, (e) => e.length + 1, (from, to) => chunks.push({ text: `[${elements.slice(from, to).join(",")}]`, lineOffset: from }));
  return { format: fmt, total: elements.length, chunks };
}
