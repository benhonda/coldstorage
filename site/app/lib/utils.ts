import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind class names, resolving conflicts (shadcn's standard `cn`).
 * The `~/lib/utils` alias for this file is pinned in `components.json`.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
