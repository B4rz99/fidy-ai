import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merges ownerless visual class values while resolving conflicting Tailwind utilities. */
export const cn = (...inputs: ReadonlyArray<ClassValue>): string => twMerge(clsx(inputs));
