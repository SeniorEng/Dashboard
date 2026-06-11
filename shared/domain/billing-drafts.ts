/**
 * Task #1198: Welche Entwurfs-Rechnungen dürfen in die Massen-Aktionen der
 * Abrechnungs-Seite (Bulk-Versand, Sammeldruck, „Alle an Pflegekassen senden")
 * einfließen?
 *
 * Storno-Belege (`invoiceType === "stornorechnung"`) sind Gutschriften und
 * werden serverseitig beim Stornieren als Entwurf (`status === "entwurf"`) mit
 * der ursprünglichen `billingType` angelegt. Sie dürfen NICHT in die Zähler
 * oder die an die Massen-Aktionen übergebenen ID-Mengen wandern — konsistent
 * mit der standardmäßig ausgeblendeten Rechnungsliste. Andernfalls behaupten
 * die Buttons z.B. „29 Rechnungen", obwohl die sichtbare Liste leer ist, und
 * die Massen-Aktionen würden reale Storno-Belege mitverarbeiten.
 *
 * Diese Prädikate sind die einzige Quelle für die Draft-Auswahl, damit
 * Anzeige-Zähler und tatsächlich verarbeitete Mengen nicht auseinanderdriften.
 */

/** Minimaler Shape, den die Prädikate brauchen (Subset von `InvoiceItem`). */
export interface BillingDraftLike {
  status: string;
  invoiceType: string;
  billingType: string;
}

const BULK_BILLING_TYPES = [
  "selbstzahler",
  "pflegekasse_gesetzlich",
  "pflegekasse_privat",
] as const;

/**
 * Aktiver Entwurf (kein Storno-Beleg)? Basis-Gate für alle Massen-Aktionen.
 */
export function isActionableDraft(inv: BillingDraftLike): boolean {
  return inv.status === "entwurf" && inv.invoiceType !== "stornorechnung";
}

/**
 * Entwurf, der im typenübergreifenden Bulk-Versand / Sammeldruck verarbeitet
 * wird (Selbstzahler + beide Pflegekassen-Varianten, ohne Storno-Belege).
 */
export function isBulkActionableDraft(inv: BillingDraftLike): boolean {
  return (
    isActionableDraft(inv) &&
    (BULK_BILLING_TYPES as readonly string[]).includes(inv.billingType)
  );
}

/**
 * Entwurf, der im „Alle an Pflegekassen senden"-Stapellauf verarbeitet wird
 * (gesetzliche Pflegekasse, ohne Storno-Belege).
 */
export function isPflegekasseBatchDraft(inv: BillingDraftLike): boolean {
  return isActionableDraft(inv) && inv.billingType === "pflegekasse_gesetzlich";
}
