import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Parses "1, 2 3;4" into integers. Returns null + error when a token is not an integer. */
export function parseIntList(text: string): { values: number[]; error: string | null } {
  const tokens = text.split(/[\s,;|]+/).filter(Boolean);
  const values: number[] = [];
  for (const t of tokens) {
    if (!/^-?\d+$/.test(t)) return { values: [], error: `"${t}" is not a whole number` };
    values.push(Number(t));
  }
  return { values, error: null };
}
