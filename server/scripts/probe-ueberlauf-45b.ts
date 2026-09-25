/**
 * Probelauf „Überlauf gespeicherter Buchungen → privat" — READ-ONLY.
 *
 * Zeigt VOR dem Deploy, was die Rechnungserstellung mit dem Fix aus
 * `neuzubuchendeTermine` (`server/services/invoice-data.ts`) für einen Kunden
 * und Monat ergibt: welche Termine neu gebucht werden und wie sich Kasse und
 * privat aufteilen. Schreibt NICHTS — läuft unter
 * `default_transaction_read_only=on`.
 *
 * Warum nicht der Engine-Probelauf der Vorschau: der bucht in einer
 * Transaktion und rollt zurück — das ist ein Schreibzugriff und gegen Prod
 * ausgeschlossen. Hier dieselbe AUSWAHL (`neuzubuchendeTermine`, lesend) und
 * dieselbe Verfügbarkeit (`readUnifiedBudgetAvailability`), die Aufteilung
 * chronologisch wie die Neubuchung: jeder Termin bekommt aus dem Topf, was am
 * Termintag frei ist, nachdem die früheren Termine des Laufs bedient sind.
 * Gleichheit mit dem echten Erstellen ist im Test gesichert
 * (`tests/billing/45b-funke-prodlage-e2e.test.ts`, F-3).
 *
 * Grenzen (werden ausgegeben, nicht verschwiegen):
 *   · Kosten = gespeicherte Buchung. Die Neubuchung rechnet zum Termindatum neu;
 *     bei geänderten Preisen kann sie abweichen.
 *   · Nur §45b. Termine mit Buchung in einem anderen Topf → Hinweis „nicht exakt".
 *
 * Aufruf:
 *   npx tsx server/scripts/probe-ueberlauf-45b.ts <kundeId> <jahr> <monat>
 *   npx tsx server/scripts/probe-ueberlauf-45b.ts --alle <jahr>   (Zählung: bei wem greift der Fix?)
 */
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { appointments, budgetTransactions } from "@shared/schema";
import { neuzubuchendeTermine } from "../services/invoice-data";
import { readUnifiedBudgetAvailability } from "../storage/budget/unified-reader";
import { activeInvoicedAppointmentIdsSqlRaw } from "../lib/appointment-invoiced";

const TOPF = "entlastungsbetrag_45b";

export interface UeberlaufProbe {
  termine: Array<{ id: number; datum: string; kostenCents: number; kasseCents: number; privatCents: number; exakt: boolean }>;
  kasseCents: number;
  privatCents: number;
  nettoNullOhneProbe: number[];
}

/** Nicht abgerechnete Termine des Monats mit (lebender oder stornierter) Buchung. */
async function laufTermine(customerId: number, jahr: number, monat: number): Promise<number[]> {
  const von = `${jahr}-${String(monat).padStart(2, "0")}-01`;
  const bis = new Date(Date.UTC(jahr, monat, 0)).toISOString().slice(0, 10);
  const zeilen = await db.selectDistinct({ id: appointments.id }).from(appointments)
    .innerJoin(budgetTransactions, eq(budgetTransactions.appointmentId, appointments.id))
    .where(and(
      eq(appointments.customerId, customerId),
      isNull(appointments.deletedAt),
      gte(appointments.date, von),
      lte(appointments.date, bis),
      sql`${appointments.id} NOT IN (${activeInvoicedAppointmentIdsSqlRaw()})`,
    ));
  return zeilen.map((z) => z.id);
}

export async function probeUeberlauf(customerId: number, jahr: number, monat: number): Promise<UeberlaufProbe> {
  const ids = await laufTermine(customerId, jahr, monat);
  const { nettoNull, ueberzogen } = await neuzubuchendeTermine(customerId, ids);
  const leer: UeberlaufProbe = { termine: [], kasseCents: 0, privatCents: 0, nettoNullOhneProbe: nettoNull };
  if (ueberzogen.length === 0) return leer;

  const buchungen = await db.select().from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    inArray(budgetTransactions.appointmentId, ueberzogen),
    inArray(budgetTransactions.transactionType, ["consumption", "reversal"]),
  ));
  const storniert = new Set(buchungen.filter((b) => b.transactionType === "reversal").map((b) => b.reversedTransactionId));
  const lebend = buchungen.filter((b) => b.transactionType === "consumption" && !storniert.has(b.id));

  const termine = await db.select({ id: appointments.id, datum: appointments.date, start: appointments.scheduledStart })
    .from(appointments).where(inArray(appointments.id, ueberzogen));
  termine.sort((a, b) => String(a.datum).localeCompare(String(b.datum)) || (a.start ?? "").localeCompare(b.start ?? "") || a.id - b.id);

  const kosten = new Map<number, number>();
  const exakt = new Map<number, boolean>();
  for (const b of lebend) {
    const id = b.appointmentId as number;
    kosten.set(id, (kosten.get(id) ?? 0) - b.amountCents);
    if (b.budgetType !== TOPF) exakt.set(id, false);
  }

  const ergebnis: UeberlaufProbe = { ...leer, termine: [] };
  let bedient = 0;
  for (const t of termine) {
    const datum = String(t.datum);
    const topf = (await readUnifiedBudgetAvailability(customerId, datum)).pots.entlastungsbetrag_45b;
    // Frei am Termintag OHNE die gespeicherten Buchungen der Lauf-Termine bis dahin,
    // abzüglich dessen, was frühere Lauf-Termine neu bekommen.
    const eigene = termine
      .filter((u) => String(u.datum) <= datum)
      .reduce((n, u) => n + (kosten.get(u.id) ?? 0), 0);
    const frei = Math.max(0, topf.allocatedCents - topf.consumedNetCents + eigene - bedient);
    const k = kosten.get(t.id) ?? 0;
    const kasse = Math.min(k, frei);
    bedient += kasse;
    ergebnis.termine.push({ id: t.id, datum, kostenCents: k, kasseCents: kasse, privatCents: k - kasse, exakt: exakt.get(t.id) ?? true });
    ergebnis.kasseCents += kasse;
    ergebnis.privatCents += k - kasse;
  }
  return ergebnis;
}

/** Alle Kunden/Monate eines Jahres, bei denen der Fix die nächste Rechnung ändert. */
export async function zaehleUeberlauf(jahr: number): Promise<{ geprueft: number; treffer: Array<{ customerId: number; monat: number; probe: UeberlaufProbe }> }> {
  const kunden = await db.selectDistinct({ id: budgetTransactions.customerId }).from(budgetTransactions)
    .where(and(eq(budgetTransactions.budgetType, TOPF), gte(budgetTransactions.transactionDate, `${jahr}-01-01`)));
  const treffer: Array<{ customerId: number; monat: number; probe: UeberlaufProbe }> = [];
  for (const { id } of kunden) {
    for (let monat = 1; monat <= 12; monat++) {
      const probe = await probeUeberlauf(id, jahr, monat);
      if (probe.termine.length > 0) treffer.push({ customerId: id, monat, probe });
    }
  }
  return { geprueft: kunden.length, treffer };
}

const euro = (c: number) => (c / 100).toFixed(2).replace(".", ",");

async function main(): Promise<void> {
  const [a, b, c] = process.argv.slice(2);
  // Nur lesend: der Aufruf setzt PGOPTIONS='-c default_transaction_read_only=on'.
  const ro = await db.execute(sql`SHOW default_transaction_read_only`);
  const wert = (ro as unknown as { rows: Array<{ default_transaction_read_only: string }> }).rows[0]?.default_transaction_read_only;
  if (wert !== "on") throw new Error("Abbruch: Verbindung ist nicht read-only (PGOPTIONS='-c default_transaction_read_only=on' setzen).");
  if (a === "--alle") {
    const jahr = Number(b);
    const { geprueft, treffer } = await zaehleUeberlauf(jahr);
    for (const t of treffer) {
      console.log(`Kunde ${t.customerId} ${String(t.monat).padStart(2, "0")}/${jahr}: ${t.probe.termine.length} Termine, Kasse ${euro(t.probe.kasseCents)} / privat ${euro(t.probe.privatCents)}`);
    }
    console.log(`\nFix greift bei ${new Set(treffer.map((t) => t.customerId)).size} Kunden in ${treffer.length} Monaten (${geprueft} Kunden mit §45b-Buchungen ${jahr} geprüft).`);
    return;
  }
  const p = await probeUeberlauf(Number(a), Number(b), Number(c));
  if (p.termine.length === 0) {
    console.log("Kein überzogener Topf — der Fix ändert an der Rechnung nichts.");
  }
  for (const t of p.termine) {
    console.log(`${t.datum}  Termin ${t.id}  ${euro(t.kostenCents)}  →  Kasse ${euro(t.kasseCents)} / privat ${euro(t.privatCents)}${t.exakt ? "" : "  (nicht exakt: Buchung auch in anderem Topf)"}`);
  }
  console.log(`SUMME  Kasse ${euro(p.kasseCents)} / privat ${euro(p.privatCents)}`);
  if (p.nettoNullOhneProbe.length > 0) console.log(`Hinweis: ${p.nettoNullOhneProbe.length} netto-null Termine (bisheriger Weg, hier nicht gerechnet).`);
}

if (process.argv[1]?.endsWith("probe-ueberlauf-45b.ts")) {
  main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
