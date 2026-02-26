import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatKm(km: number | string | null | undefined): string {
  return Number(km ?? 0).toFixed(1).replace(".", ",");
}
