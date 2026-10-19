import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export { parseIntList, parseCardList, SUIT_SYMBOL } from "@shared/parsing";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
