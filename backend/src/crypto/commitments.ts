import { sha256Hex } from "./hmac.js";
import type { CommitmentResult, CommitmentScheme } from "../../../shared/src/contracts.js";

export type { CommitmentResult, CommitmentScheme, CommitmentStatus } from "../../../shared/src/contracts.js";

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * Commitment check.
 * "unconfirmed" is the default: Solpump's exact commitment construction could not be
 * independently confirmed, so a supplied hash is only compared against a candidate and
 * never reported as verified. Commitments are public values, so a constant-time
 * comparison is not needed (nothing secret can leak through timing here).
 */
export function checkCommitment(serverSeed: string, supplied: string | null | undefined, scheme: CommitmentScheme): CommitmentResult {
  const candidateSha256 = sha256Hex(Buffer.from(serverSeed, "utf8"));
  const s = supplied && supplied.length > 0 ? supplied : null;
  // Hex comparison is case-insensitive; surrounding whitespace in a *hash* field is not part of the hash.
  const normalized = s?.trim().toLowerCase() ?? null;
  const suppliedLooksLikeSha256 = normalized === null ? null : SHA256_HEX.test(normalized);
  const candidateMatches = normalized === null ? null : normalized === candidateSha256;
  const formatNote = suppliedLooksLikeSha256 === false ? " The supplied value is not a 64-character hex SHA-256 digest." : "";

  if (s === null) {
    return { status: "not_supplied", scheme, supplied: null, candidateSha256, candidateMatches, suppliedLooksLikeSha256, note: "No commitment supplied." };
  }
  if (scheme === "unconfirmed") {
    return {
      status: "scheme_unconfirmed",
      scheme,
      supplied: s,
      candidateSha256,
      candidateMatches,
      suppliedLooksLikeSha256,
      note:
        "Commitment scheme not confirmed against Solpump's published scheme. " +
        `Candidate SHA-256(serverSeed) ${candidateMatches ? "equals" : "does NOT equal"} the supplied value.${formatNote} ` +
        "Confirm the scheme in Settings before this can be reported as verified.",
    };
  }
  return {
    status: candidateMatches ? "verified" : "mismatch",
    scheme,
    supplied: s,
    candidateSha256,
    candidateMatches,
    suppliedLooksLikeSha256,
    note: candidateMatches
      ? "SHA-256(UTF-8 serverSeed) equals the supplied commitment (scheme confirmed by user in Settings)."
      : `SHA-256(UTF-8 serverSeed) does not equal the supplied commitment.${formatNote}`,
  };
}
