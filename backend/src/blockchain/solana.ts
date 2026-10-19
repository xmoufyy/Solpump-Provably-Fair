/**
 * Read-only, game-agnostic Solana evidence lookup.
 *
 * Solpump's on-chain program IDs, account layouts and event formats could not be
 * independently confirmed, so this module deliberately implements NO Solpump-specific
 * decoding. It fetches a transaction by signature over standard JSON-RPC and reports:
 *  - slot / block time (an independent timestamp for whatever the transaction contains)
 *  - invoked program IDs, log messages and memo text
 *  - whether user-supplied strings (e.g. a commitment hash or seed) literally appear in it
 * It never requires a wallet or key and never sends transactions.
 */
export interface TxEvidence {
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

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const MEMO_PROGRAMS = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);

export function isValidSignature(sig: string) {
  return SIG_RE.test(sig);
}

export async function fetchTransactionEvidence(rpcUrl: string, signature: string, needles: string[] = []): Promise<TxEvidence> {
  if (!isValidSignature(signature)) throw new Error("Not a valid base58 transaction signature");
  const url = new URL(rpcUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("RPC URL must be http(s)");

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: any; error?: { message: string } };
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);

  const caveat =
    "Generic transaction evidence only. This tool does not decode Solpump-specific program data. " +
    "Block time proves when this transaction was finalised, not that it is Solpump's commitment for a given round — confirm that independently.";
  const tx = body.result;
  if (!tx) {
    return { signature, found: false, slot: null, blockTime: null, blockTimeIso: null, err: null, programIds: [], logMessages: [], memos: [], searches: needles.map((n) => ({ needle: n, foundIn: [] })), caveat };
  }

  const instructions: any[] = [
    ...(tx.transaction?.message?.instructions ?? []),
    ...((tx.meta?.innerInstructions ?? []) as any[]).flatMap((ii) => ii.instructions ?? []),
  ];
  const programIds = [...new Set(instructions.map((i) => i.programId).filter(Boolean))] as string[];
  const memos = instructions
    .filter((i) => MEMO_PROGRAMS.has(i.programId))
    .map((i) => (typeof i.parsed === "string" ? i.parsed : JSON.stringify(i.parsed ?? i.data)));
  const logMessages: string[] = tx.meta?.logMessages ?? [];
  const rawJson = JSON.stringify(tx);

  const searches = needles
    .filter((n) => n.length >= 6)
    .map((needle) => {
      const foundIn: string[] = [];
      if (logMessages.some((l) => l.includes(needle))) foundIn.push("log messages");
      if (memos.some((m) => m.includes(needle))) foundIn.push("memo");
      if (!foundIn.length && rawJson.includes(needle)) foundIn.push("transaction JSON");
      const b64 = Buffer.from(needle, "utf8").toString("base64").replace(/=+$/, "");
      if (b64.length >= 8 && rawJson.includes(b64)) foundIn.push("base64 data (UTF-8 encoding)");
      if (/^[0-9a-f]{64}$/i.test(needle)) {
        const raw64 = Buffer.from(needle, "hex").toString("base64").replace(/=+$/, "");
        if (rawJson.includes(raw64)) foundIn.push("base64 data (raw 32 bytes)");
      }
      return { needle, foundIn };
    });

  return {
    signature,
    found: true,
    slot: tx.slot ?? null,
    blockTime: tx.blockTime ?? null,
    blockTimeIso: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
    err: tx.meta?.err ?? null,
    programIds,
    logMessages,
    memos,
    searches,
    caveat,
  };
}
