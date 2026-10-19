export type Game = "crash" | "blackjack" | "keno" | "mines";
export type AlgorithmVersion = "hmac_sha256_v2" | "seedrandom_v1";
export type KenoDifficulty = "CLASSIC" | "LOW" | "MEDIUM" | "HIGH" | "EXTREME";

export interface TraceStep {
  section: string;
  label: string;
  value: string;
  note?: string;
}

export interface VerificationResult {
  game: string;
  roundId: string | null;
  algorithmVersion: string | null;
  inputs: Record<string, unknown>;
  calculated: Record<string, any> | null;
  reported: Record<string, any> | null;
  outcome: { status: string; details: string[] };
  commitment: { status: string; note: string; supplied?: string | null; candidateSha256?: string; candidateMatches?: boolean | null; scheme?: string };
  timing: { status: string; note: string };
  payout: { status: string; note: string } | null;
  overall: string;
  errors: { field: string; message: string }[];
  trace: TraceStep[];
  computedAt: string;
  appVersion: string;
}

export interface StoredRound {
  id: number;
  roundId: string | null;
  game: string;
  algorithmVersion: string | null;
  nonce: string | null;
  serverSeed: string | null;
  clientSeed: string | null;
  outcomeStatus: string;
  commitmentStatus: string;
  timingStatus: string;
  overallStatus: string;
  evidenceSource: string | null;
  roundTimestamp: string | null;
  auditedAt: string;
  recorded: any;
  calculated: any;
  result: VerificationResult;
}

export interface Settings {
  commitmentScheme: "unconfirmed" | "sha256_utf8_hex";
  solanaRpcUrl: string;
}

export const SERVER_DOWN_MESSAGE =
  "Cannot reach the Fairness Lab server. Start it with start.bat (keep that window open) and reload this page.";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
    });
  } catch {
    // fetch only rejects on network failure: the local server is not running / not reachable.
    throw new Error(SERVER_DOWN_MESSAGE);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Unexpected response from ${url} (HTTP ${res.status}). Is the page being served by the Fairness Lab server?`);
  }
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
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

export const api = {
  verify: (input: Record<string, unknown>, save = false) =>
    req<{ result: VerificationResult; savedId: number | null }>("/api/verify", { method: "POST", body: JSON.stringify({ input, save }) }),
  compareVersions: (input: Record<string, unknown>) =>
    req<{ note: string; results: VerificationResult[] }>("/api/compare-versions", { method: "POST", body: JSON.stringify(input) }),
  hmac: (body: unknown) =>
    req<{ keyHex: string; messageHex: string; hmac: string; sha256OfKey: string }>("/api/tools/hmac", { method: "POST", body: JSON.stringify(body) }),
  transcript: (parts: string[]) => req<{ hex: string }>("/api/tools/transcript", { method: "POST", body: JSON.stringify({ parts }) }),
  rounds: (params: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [string, string][]);
    return req<{ total: number; rounds: StoredRound[] }>(`/api/rounds?${qs}`);
  },
  round: (id: number) => req<StoredRound>(`/api/rounds/${id}`),
  deleteRound: (id: number) => req<{ deleted: number }>(`/api/rounds/${id}`, { method: "DELETE" }),
  reverify: (id: number) => req<{ reproduced: boolean; fresh: VerificationResult }>(`/api/rounds/${id}/reverify`, { method: "POST" }),
  importData: (text: string, format: string, filename?: string) =>
    req<{
      batchId: string;
      format: string;
      total: number;
      stored: { id: number; line: number; roundId: string | null; game: string; outcome: string; overall: string }[];
      rejected: { line: number; error: string }[];
    }>("/api/import", { method: "POST", body: JSON.stringify({ text, format, filename }) }),
  imports: () => req<any[]>("/api/imports"),
  stats: () => req<any>("/api/stats"),
  integrity: () => req<{ checked: number; findings: { check: string; severity: string; title: string; detail: string; roundIds: number[] }[] }>("/api/integrity"),
  settings: () => req<Settings>("/api/settings"),
  saveSettings: (s: Partial<Settings>) => req<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
  chainTx: (signature: string, needles: string[]) => req<any>("/api/chain/tx", { method: "POST", body: JSON.stringify({ signature, needles }) }),
  exportUrl: (format: string, params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams({ format, ...(Object.fromEntries(Object.entries(params).filter(([, v]) => v)) as Record<string, string>) });
    return `/api/export?${qs}`;
  },
};

export const STATUS_LABELS: Record<string, string> = {
  reconstructed: "Reconstructed",
  match: "Match",
  mismatch: "Mismatch",
  missing_comparison: "Missing comparison",
  invalid_input: "Invalid input",
  unsupported_version: "Unsupported version",
  verified: "Commitment verified",
  not_supplied: "No commitment supplied",
  scheme_unconfirmed: "Commitment scheme unconfirmed",
  pre_round_publication_verified: "Pre-round publication verified",
  publication_timing_unverified: "Publication timing unverified",
  verified_sufficient_evidence: "Verified with sufficient evidence",
  match_commitment_unproven: "Result matches, commitment unproven",
  reconstructed_only: "Reconstructed only",
  incomplete: "Incomplete",
  unsupported: "Unsupported",
};

export function statusTone(s: string): "ok" | "bad" | "warn" | "info" | "neutral" | "accent" {
  if (["match", "verified", "verified_sufficient_evidence", "pre_round_publication_verified"].includes(s)) return "ok";
  if (["mismatch"].includes(s)) return "bad";
  if (["invalid_input", "unsupported_version", "incomplete", "unsupported"].includes(s)) return "warn";
  if (["match_commitment_unproven", "scheme_unconfirmed", "publication_timing_unverified"].includes(s)) return "info";
  return "neutral";
}

export const VERSION_LABELS: Record<string, string> = {
  hmac_sha256_v2: "HMAC SHA256 V2 (current)",
  seedrandom_v1: "Seedrandom V1 (legacy)",
  crash_hmac_sha256_v1: "Crash HMAC-SHA256",
  blackjack_hmac_sha256_card_v1: "Blackjack per-card HMAC",
};
