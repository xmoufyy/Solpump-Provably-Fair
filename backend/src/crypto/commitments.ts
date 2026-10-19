import { sha256Hex } from "./hmac.js";

export type CommitmentStatus = "verified" | "mismatch" | "not_supplied" | "scheme_unconfirmed";

/**
 * Commitment schemes the lab knows how to compute.
 * "unconfirmed" is the default: Solpump's exact commitment construction could not be
 * independently confirmed from the published fairness pages at build time, so a supplied
 * hash is only *compared against a candidate* and never reported as verified.
 */
export type CommitmentScheme = "unconfirmed" | "sha256_utf8_hex";

export interface CommitmentResult {
  status: CommitmentStatus;
  scheme: CommitmentScheme;
  supplied: string | null;
  /** SHA-256(UTF-8 serverSeed) hex, always shown for reference */
  candidateSha256: string;
  candidateMatches: boolean | null;
  note: string;
}

export function checkCommitment(
  serverSeed: string,
  supplied: string | null | undefined,
  scheme: CommitmentScheme,
): CommitmentResult {
  const candidateSha256 = sha256Hex(Buffer.from(serverSeed, "utf8"));
  const s = supplied && supplied.length > 0 ? supplied : null;
  // Hex comparison is case-insensitive; surrounding whitespace in a *hash* field is not part of the hash.
  const candidateMatches = s === null ? null : s.trim().toLowerCase() === candidateSha256;

  if (s === null) {
    return { status: "not_supplied", scheme, supplied: null, candidateSha256, candidateMatches, note: "No commitment supplied." };
  }
  if (scheme === "unconfirmed") {
    return {
      status: "scheme_unconfirmed",
      scheme,
      supplied: s,
      candidateSha256,
      candidateMatches,
      note:
        "Commitment scheme not confirmed against Solpump's published scheme. " +
        `Candidate SHA-256(serverSeed) ${candidateMatches ? "equals" : "does NOT equal"} the supplied value. ` +
        "Confirm the scheme in Settings before this can be reported as verified.",
    };
  }
  return {
    status: candidateMatches ? "verified" : "mismatch",
    scheme,
    supplied: s,
    candidateSha256,
    candidateMatches,
    note: candidateMatches
      ? "SHA-256(UTF-8 serverSeed) equals the supplied commitment (scheme confirmed by user in Settings)."
      : "SHA-256(UTF-8 serverSeed) does not equal the supplied commitment.",
  };
}
