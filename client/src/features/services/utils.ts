import { formatEuroDE } from "@shared/utils/money";

export function formatPrice(cents: number): string {
  return formatEuroDE(cents, { withCurrency: false });
}
