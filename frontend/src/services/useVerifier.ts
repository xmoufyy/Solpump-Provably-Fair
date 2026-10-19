import { useCallback, useRef, useState } from "react";
import type { Game, VerificationResult } from "@shared/contracts";
import { api } from "./api";

/**
 * Runs a verification and remembers which exact input produced the displayed result, so the UI
 * can flag a stale result as soon as any input changes. Out-of-order responses are discarded.
 */
export function useVerifier<G extends Game>() {
  const [result, setResult] = useState<VerificationResult<G> | null>(null);
  const [resultKey, setResultKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const seq = useRef(0);

  const run = useCallback(async (input: Record<string, unknown>, save = false) => {
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const { result, savedId } = await api.verify(input, save);
      if (mine !== seq.current) return null;
      setResult(result as VerificationResult<G>);
      setResultKey(JSON.stringify(input));
      if (savedId) setSaved(savedId);
      return result;
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
      return null;
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, []);

  const isStale = (input: Record<string, unknown>) => result !== null && resultKey !== JSON.stringify(input);

  return { result, busy, error, saved, run, isStale };
}
