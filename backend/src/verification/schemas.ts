import { z } from "zod";
import { KENO_DIFFICULTIES, LIMITS } from "../../../shared/src/contracts.js";

/**
 * Seed fields are validated (non-empty, bounded length) but NEVER trimmed or normalised:
 * the exact bytes the user entered are what gets hashed. Over-long values are rejected
 * with an explicit error rather than truncated.
 */
const seed = (name: string) =>
  z
    .string({ required_error: `${name} is required`, invalid_type_error: `${name} must be text` })
    .min(1, `${name} is required`)
    .max(LIMITS.seedLength, `${name} is longer than ${LIMITS.seedLength} characters`);
const optionalText = z.string().max(LIMITS.textField, `must be at most ${LIMITS.textField} characters`).optional().nullable();

/**
 * Array bounded BEFORE its elements are validated. z.array(item).max(n) validates every element first and
 * records one issue per bad element: a 16 MB body of 4M invalid values cost ~2.2 GB and 8 s of a blocked
 * event loop. Checking the length on unknown elements first keeps the cost bounded by `max`.
 */
export function boundedArray<T extends z.ZodTypeAny>(item: T, max: number, message = `at most ${max} values`) {
  return z.array(z.unknown()).max(max, message).pipe(z.array(item));
}
const intList = (max: number) => boundedArray(z.number().int(), max);
const nonce = z
  .string({ required_error: "Nonce is required", invalid_type_error: "Nonce must be text (numeric nonces are passed as strings to preserve every digit)" })
  .min(1, "Nonce is required")
  .max(LIMITS.nonceLength, `Nonce is longer than ${LIMITS.nonceLength} characters`);

const common = {
  roundId: optionalText,
  commitment: optionalText,
  timestamp: optionalText,
  source: optionalText,
  txSignature: optionalText,
};

/** Algorithm version is mandatory for Keno/Mines - never inferred from which version "matches". */
const versionField = z.string({ required_error: "algorithmVersion is required (hmac_sha256_v2 or seedrandom_v1)" }).max(64);

export const crashInputSchema = z.object({
  game: z.literal("crash"),
  serverSeed: seed("Server seed"),
  clientSeed: seed("Public seed"),
  reported: z.object({ multiplier: z.number().positive().finite().optional().nullable() }).optional().nullable(),
  ...common,
});

export const blackjackInputSchema = z.object({
  game: z.literal("blackjack"),
  serverSeed: seed("Server seed"),
  clientSeed: seed("Public seed"),
  cardCount: z.number().int().min(1).max(LIMITS.blackjackCards).default(10),
  reported: z
    .object({
      cards: boundedArray(z.object({ label: z.string().max(8), suit: z.string().max(16) }), LIMITS.blackjackCards, `at most ${LIMITS.blackjackCards} reported cards`)
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),
  ...common,
});

export const kenoInputSchema = z.object({
  game: z.literal("keno"),
  serverSeed: seed("Server seed"),
  clientSeed: seed("Client seed"),
  nonce,
  algorithmVersion: versionField,
  difficulty: z.enum(KENO_DIFFICULTIES as unknown as [string, ...string[]], { required_error: "Difficulty is required" }),
  selectedNumbers: intList(LIMITS.listLength).optional().nullable(),
  reported: z.object({ draw: intList(LIMITS.listLength).optional().nullable() }).optional().nullable(),
  ...common,
});

export const minesInputSchema = z.object({
  game: z.literal("mines"),
  serverSeed: seed("Server seed"),
  clientSeed: seed("Client seed"),
  nonce,
  algorithmVersion: versionField,
  gridSize: z.number().int(),
  mineCount: z.number().int(),
  /** Base of reported positions AND clicked tiles as entered (internal indices are always 0-based). */
  indexBase: z.union([z.literal(0), z.literal(1)]).default(0),
  clickedTiles: intList(LIMITS.listLength).optional().nullable(),
  reported: z
    .object({ mines: intList(LIMITS.listLength).optional().nullable(), outcome: z.enum(["win", "loss"]).optional().nullable() })
    .optional()
    .nullable(),
  ...common,
});

export const roundInputSchema = z.discriminatedUnion("game", [crashInputSchema, blackjackInputSchema, kenoInputSchema, minesInputSchema]);

export type RoundInput = z.infer<typeof roundInputSchema>;
