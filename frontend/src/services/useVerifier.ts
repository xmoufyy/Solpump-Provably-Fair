import { useCallback, useState } from "react";
import { api, type VerificationResult } from "./api";

/**
 * Runs a verification against the backend and remembers which exact input produced the
 * displayed result, so the UI can flag a stale result once any input changes.
 */
export function useVerifier() {
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [resultKey, setResultKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  const run = useCallback(async (input: Record<string, unknown>, save = false) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const { result, savedId } = await api.verify(input, save);
      setResult(result);
      setResultKey(JSON.stringify(input));
      if (savedId) setSaved(savedId);
      return result;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const isStale = (input: Record<string, unknown>) => result !== null && resultKey !== JSON.stringify(input);

  return { result, busy, error, saved, run, isStale, reset: () => (setResult(null), setResultKey(null)) };
}
