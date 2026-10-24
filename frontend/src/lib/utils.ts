import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export { parseIntList, parseCardList, seedHazards, SUIT_SYMBOL } from "@shared/parsing";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
