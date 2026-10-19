import { z } from "zod";
import { KENO_DIFFICULTIES } from "../games/keno.js";
import { MAX_BLACKJACK_CARDS } from "../games/blackjack.js";

/**
 * Seed fields are validated as non-empty strings but NEVER trimmed or normalised:
 * the exact bytes the user entered are what gets hashed.
 */
const seed = (name: string) => z.string({ required_error: `${name} is required` }).min(1, `${name} is required`);
const optionalText = z.string().optional().nullable();
const intList = z.array(z.number().int());

const common = {
  roundId: optionalText,
  commitment: optionalText,
  timestamp: optionalText,
  source: optionalText,
  txSignature: optionalText,
};

/** Algorithm version is mandatory for Keno/Mines — never inferred from which version "matches". */
const versionField = z.string({ required_error: "algorithmVersion is required (hmac_sha256_v2 or seedrandom_v1)" });

export const crashInputSchema = z.object({
  game: z.literal("crash"),
  serverSeed: seed("Server seed"),
  clientSeed: seed("Public seed"),
  reported: z.object({ multiplier: z.number().positive().optional().nullable() }).optional().nullable(),
  ...common,
});

export const blackjackInputSchema = z.object({
  game: z.literal("blackjack"),
  serverSeed: seed("Server seed"),
  clientSeed: seed("Public seed"),
  cardCount: z.number().int().min(1).max(MAX_BLACKJACK_CARDS).default(10),
  reported: z
    .object({ cards: z.array(z.object({ label: z.string(), suit: z.string() })).optional().nullable() })
    .optional()
    .nullable(),
  ...common,
});

export const kenoInputSchema = z.object({
  game: z.literal("keno"),
  serverSeed: seed("Server seed"),
  clientSeed: seed("Client seed"),
  nonce: z.string({ required_error: "Nonce is required" }).min(1, "Nonce is required"),
  algorithmVersion: versionField,
  difficulty: z.enum(KENO_DIFFICULTIES as [string, ...string[]], { required_error: "Difficulty is required" }),
  selectedNumbers: intList.optional().nullable(),
  reported: z.object({ draw: intList.optional().nullable() }).optional().nullable(),
  ...common,
});

export const minesInputSchema = z.object({
  game: z.literal("mines"),
  serverSeed: seed("Server seed"),
  clientSeed: seed("Client seed"),
  nonce: z.string({ required_error: "Nonce is required" }).min(1, "Nonce is required"),
  algorithmVersion: versionField,
  gridSize: z.number().int(),
  mineCount: z.number().int(),
  /** Base of reported positions / clicked tiles as entered by the user (internal indices are always 0-based). */
  indexBase: z.union([z.literal(0), z.literal(1)]).default(0),
  clickedTiles: intList.optional().nullable(),
  reported: z
    .object({ mines: intList.optional().nullable(), outcome: z.enum(["win", "loss"]).optional().nullable() })
    .optional()
    .nullable(),
  ...common,
});

export const roundInputSchema = z.discriminatedUnion("game", [
  crashInputSchema,
  blackjackInputSchema,
  kenoInputSchema,
  minesInputSchema,
]);

export type RoundInput = z.infer<typeof roundInputSchema>;
export type CrashInput = z.infer<typeof crashInputSchema>;
export type BlackjackInput = z.infer<typeof blackjackInputSchema>;
export type KenoInput = z.infer<typeof kenoInputSchema>;
export type MinesInput = z.infer<typeof minesInputSchema>;
