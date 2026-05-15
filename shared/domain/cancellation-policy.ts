/**
 * Task #485 — Cancellation-Policy (Customer-No-Show)
 *
 * Pure, side-effect-free Berechnung dessen, was einem Kunden bei einem
 * No-Show ("Vergebliche Anfahrt") privat in Rechnung gestellt werden darf.
 *
 * Wichtige Invarianten:
 *  - §45b/Pflegekasse-Budget wird beim Aufrufer NICHT verbraucht (No-Show
 *    erzeugt keine `consumption_transaction`). Diese Funktion liefert nur
 *    den Brutto-Cent-Betrag für die Privatrechnung.
 *  - Rückgabewert ist immer >= 0; negative Eingaben werden auf 0 geklemmt.
 *  - Wenn Policy "none" gilt oder keine Sätze gepflegt sind → 0 Cent.
 */

export const CANCELLATION_POLICY_TYPES = [
  "none",
  "flat_amount",
  "travel_plus_wait",
] as const;

export type CancellationPolicyType = typeof CANCELLATION_POLICY_TYPES[number];

export const CANCELLATION_POLICY_LABELS: Record<CancellationPolicyType, string> = {
  none: "Keine Verrechnung",
  flat_amount: "Pauschalbetrag",
  travel_plus_wait: "Anfahrt + Wartezeit",
};

export interface CancellationPolicy {
  type: CancellationPolicyType;
  flatCents?: number | null;
  hourlyRateCents?: number | null;
  kmRateCents?: number | null;
}

export interface NoShowInput {
  travelKilometers: number;
  waitMinutes: number;
}

export interface NoShowCharge {
  totalCents: number;
  travelCents: number;
  waitCents: number;
  flatCents: number;
  description: string;
}

function clampNonNegative(n: number | null | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Berechnet, was bei einem Kunden-No-Show privat berechnet werden darf.
 * @param policy   Kundenspezifische Cancellation-Policy
 * @param input    Reale Anfahrt-Kilometer und Wartezeit-Minuten
 * @param fallback Optional: Default-Sätze aus Service-Katalog (km-Satz,
 *                 Stunden-Satz für Wartezeit). Werden nur verwendet, wenn
 *                 die Policy keinen eigenen Wert hat.
 */
export function computeNoShowCharge(
  policy: CancellationPolicy,
  input: NoShowInput,
  fallback: { kmRateCents?: number | null; hourlyRateCents?: number | null } = {},
): NoShowCharge {
  const km = clampNonNegative(input.travelKilometers);
  const waitMin = clampNonNegative(input.waitMinutes);

  if (policy.type === "none") {
    return { totalCents: 0, travelCents: 0, waitCents: 0, flatCents: 0, description: "" };
  }

  if (policy.type === "flat_amount") {
    const flat = clampNonNegative(policy.flatCents);
    return {
      totalCents: flat,
      travelCents: 0,
      waitCents: 0,
      flatCents: flat,
      description: "Vergebliche Anfahrt (Pauschale)",
    };
  }

  // travel_plus_wait
  const kmRate = clampNonNegative(policy.kmRateCents ?? fallback.kmRateCents);
  const hourlyRate = clampNonNegative(policy.hourlyRateCents ?? fallback.hourlyRateCents);
  const travelCents = Math.round(km * kmRate);
  const waitCents = Math.round((waitMin / 60) * hourlyRate);
  const total = travelCents + waitCents;

  const parts: string[] = [];
  if (km > 0 && kmRate > 0) parts.push(`${km.toFixed(1)} km Anfahrt`);
  if (waitMin > 0 && hourlyRate > 0) parts.push(`${waitMin} Min. Wartezeit`);
  const description = parts.length > 0
    ? `Vergebliche Anfahrt (${parts.join(" + ")})`
    : "Vergebliche Anfahrt";

  return {
    totalCents: total,
    travelCents,
    waitCents,
    flatCents: 0,
    description,
  };
}

/**
 * Prüft, ob für einen Kunden überhaupt etwas berechnet werden darf
 * (Policy != "none"). UI nutzt dies, um den Vorschau-Block zu zeigen
 * bzw. komplett auszublenden.
 */
export function hasChargeableCancellationPolicy(policy: CancellationPolicy): boolean {
  return policy.type !== "none";
}
