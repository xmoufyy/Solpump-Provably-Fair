import type {
  ImportJob,
  IntegrityReport,
  RoundSummary,
  SeedSession,
  Settings,
  Stats,
  StoredRound,
  VerificationResult,
} from "@shared/contracts";

export {
  OVERALL_EXPLANATIONS,
  STATUS_LABELS,
  VERSION_LABELS,
  KENO_BOARD,
  KENO_DIFFICULTIES,
  KENO_MAX_PICKS,
  MINES_GRID_SIZES,
  type AlgorithmVersion,
  type ComparisonRow,
  type Game,
  type ImportJob,
  type IntegrityFinding,
  type KenoDifficulty,
  type RoundSummary,
  type SeedSession,
  type Settings,
  type Stats,
  type StoredRound,
  type TraceStep,
  type VerificationResult,
} from "@shared/contracts";

export const SERVER_DOWN_MESSAGE =
  "Cannot reach the Fairness Lab server. Start it with start.bat (keep that window open) and reload this page.";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    // fetch only rejects on network failure: the local server is not running / not reachable.
    throw new ApiError(0, SERVER_DOWN_MESSAGE);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, `Unexpected response from ${url} (HTTP ${res.status}). Is the page served by the Fairness Lab server?`);
  }
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    return r.ok && (await r.json()).ok === true;
  } catch {
    return false;
  }
}

const qs = (params: Record<string, string | number | undefined | null>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "") as [string, string][]).toString();

export interface RoundFilter {
  game?: string;
  status?: string;
  outcome?: string;
  batch?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

const post = (body?: unknown): RequestInit => ({ method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  verify: (input: Record<string, unknown>, save = false) => req<{ result: VerificationResult; savedId: number | null }>("/api/verify", post({ input, save })),
  compareVersions: (input: Record<string, unknown>) => req<{ note: string; results: VerificationResult[] }>("/api/compare-versions", post(input)),
  hmac: (body: unknown) => req<{ keyHex: string; messageHex: string; hmac: string; sha256OfKey: string }>("/api/tools/hmac", post(body)),
  transcript: (parts: string[]) => req<{ hex: string }>("/api/tools/transcript", post({ parts })),

  rounds: (f: RoundFilter, signal?: AbortSignal) => req<{ total: number; rounds: RoundSummary[] }>(`/api/rounds?${qs({ ...f })}`, { signal }),
  round: (id: number) => req<StoredRound>(`/api/rounds/${id}`),
  deleteRound: (id: number) => req<{ deleted: number }>(`/api/rounds/${id}`, { method: "DELETE" }),
  reverify: (id: number, update = false) => req<{ reproduced: boolean; updated: boolean; fresh: VerificationResult }>(`/api/rounds/${id}/reverify${update ? "?update=1" : ""}`, post()),
  reverifyMany: (f: RoundFilter) => req<{ rounds: number; reproduced: number; statusChanged: number }>("/api/rounds/reverify", post(f)),
  scriptUrl: (id: number) => `/api/rounds/${id}/script`,

  startImport: (text: string, format: string, filename?: string, skipDuplicates = true) =>
    req<{ job: ImportJob }>("/api/import", post({ text, format, filename, skipDuplicates })),
  importJob: (id: string) => req<ImportJob>(`/api/import/jobs/${id}`),
  controlImport: (id: string, action: "pause" | "resume" | "cancel") => req<ImportJob>(`/api/import/jobs/${id}/${action}`, post()),
  imports: () => req<ImportJob[]>("/api/imports"),

  stats: (f: RoundFilter = {}) => req<Stats>(`/api/stats?${qs({ ...f })}`),
  integrity: () => req<IntegrityReport>("/api/integrity"),
  sessions: (game?: string, offset = 0) => req<{ total: number; sessions: SeedSession[] }>(`/api/sessions?${qs({ game, offset, limit: 50 })}`),

  meta: () => req<{ version: string; schemaVersion: number; migration: { from: number; to: number; backup: string | null } | null }>("/api/meta"),
  settings: () => req<Settings>("/api/settings"),
  saveSettings: (s: Partial<Settings>) => req<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
  backup: () => req<{ file: string; bytes: number }>("/api/backup", post()),
  chainTx: (signature: string, needles: string[]) => req<ChainEvidence>("/api/chain/tx", post({ signature, needles })),
  exportUrl: (format: string, f: RoundFilter & { ids?: string } = {}) => `/api/export?${qs({ format, ...f })}`,
};

export interface ChainEvidence {
  signature: string;
  found: boolean;
  slot: number | null;
  blockTime: number | null;
  blockTimeIso: string | null;
  err: unknown;
  programIds: string[];
  logMessages: string[];
  memos: string[];
  searches: { needle: string; foundIn: string[] }[];
  caveat: string;
}

export type Tone = "ok" | "bad" | "warn" | "info" | "neutral" | "accent";
export function statusTone(s: string): Tone {
  if (["match", "verified", "verified_sufficient_evidence", "pre_round_publication_verified"].includes(s)) return "ok";
  if (["mismatch", "commitment_mismatch"].includes(s)) return "bad";
  if (["invalid_input", "unsupported_version", "incomplete", "unsupported"].includes(s)) return "warn";
  if (["match_commitment_unproven", "scheme_unconfirmed", "publication_timing_unverified"].includes(s)) return "info";
  return "neutral";
}
