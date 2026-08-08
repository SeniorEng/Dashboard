/**
 * #66 — SSoT der Frage „wurde dieser Beleg je ausgegeben?".
 *
 * Ausgegeben heißt: die Rechnung war mindestens einmal im Status `versendet`
 * (manuelle „als versendet"-Markierung, Sammelversand oder echter Versand).
 * Die Marke `invoices.issued_at` wird am Engpass `updateInvoiceStatusTx`
 * gesetzt und überlebt ein Zurücksetzen — anders als `sent_at`, das dabei
 * geleert wird. Genau darauf beruhte die Belegnummern-Wiedervergabe.
 *
 * WARUM als eigene Funktion und nicht inline: das Prädikat stand nach dem
 * ersten Wurf viermal wörtlich im Code — und der VIERTE Löschpfad
 * (`draft-invoice-regen.ts`, Monats-Umwidmung) hatte es vergessen. Genau die
 * Lücke, gegen die CLAUDE.md die SSoT-Regel stellt: Anzeige-, Schreib- UND
 * Filterpfade importieren dieselbe Funktion.
 */
import { isNull, type SQL } from "drizzle-orm";
import { invoices } from "@shared/schema";

/**
 * Drizzle-Bedingung „NIE ausgegeben" — für Löschpfade. Nur was diese Bedingung
 * erfüllt, darf hart gelöscht werden; alles andere wird storniert.
 */
export function neverIssuedCondition(): SQL {
  return isNull(invoices.issuedAt);
}

/** Reines Prädikat für Lesepfade und Anzeige-Entscheidungen. */
export function isInvoiceIssued(inv: { issuedAt: Date | string | null }): boolean {
  return inv.issuedAt !== null;
}
