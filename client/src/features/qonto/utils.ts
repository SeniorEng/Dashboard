import { formatEuroDE } from "@shared/utils/money";

export function formatCents(cents: number): string {
  return formatEuroDE(cents);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
