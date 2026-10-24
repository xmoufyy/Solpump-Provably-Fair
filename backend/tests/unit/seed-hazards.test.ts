/** QoL: advisory seed warnings. They describe characters; they never change the value. */
import { describe, expect, it } from "vitest";
import { seedHazards } from "../../../shared/src/parsing.js";
import { EVIDENCE_EXPLANATIONS } from "../../../shared/src/contracts.js";

const ch = (cp: number) => String.fromCodePoint(cp);

describe("seedHazards", () => {
  it("is silent for ordinary seeds, including non-ASCII letters", () => {
    expect(seedHazards("SERVER_TEST_2026")).toEqual([]);
    expect(seedHazards("graine-été")).toEqual([]);
  });
  it("names surrounding whitespace, invisible and control characters with positions", () => {
    expect(seedHazards(" abc")).toEqual(["leading or trailing whitespace"]);
    expect(seedHazards(`ab${ch(0x200b)}c${ch(0x200b)}`)).toEqual(["zero-width space (U+200B) at positions 3, 5"]);
    expect(seedHazards(`a${ch(0xa0)}b`)).toEqual(["no-break space (U+00A0) at position 2"]);
    expect(seedHazards(`a${ch(0x202e)}b`)).toEqual(["bidirectional control (U+202E) at position 2"]);
    expect(seedHazards("a\tb")).toEqual(["control character (U+0009) at position 2"]);
  });
  it("counts positions by code point, so an emoji before the character does not shift it", () => {
    expect(seedHazards(`${ch(0x1f600)}${ch(0x200d)}`)).toEqual(["zero-width joiner (U+200D) at position 2"]);
  });
});

describe("EVIDENCE_EXPLANATIONS", () => {
  it("never describes timing or an unconfirmed commitment as proof", () => {
    expect(EVIDENCE_EXPLANATIONS.publication_timing_unverified.missing).toMatch(/Timestamped evidence/);
    expect(EVIDENCE_EXPLANATIONS.scheme_unconfirmed.shows).toMatch(/only a candidate/);
    expect(EVIDENCE_EXPLANATIONS.match.missing).toMatch(/does not show the seeds were fixed/);
  });
});
