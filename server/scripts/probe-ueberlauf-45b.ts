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
 *   npx tsx server/scripts/probe-ueberlauf-45b.ts --alle <jahr>   (Zählung: bei wem greift der Fix? Fortschritt je Kunde/Monat)
 */
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { appointments, budgetAllocations, budgetTransactions, customers } from "@shared/schema";
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

/**
 * Alle Kunden/Monate eines Jahres, bei denen der Fix die nächste Rechnung ändert.
 *
 * Vorauswahl in EINER Abfrage: nur Paare (Kunde, Monat) mit OFFENEN
 * (nicht abgerechneten, nicht gelöschten) Terminen, die eine lebende
 * §45b-Buchung tragen — nur dort kann `neuzubuchendeTermine` etwas finden
 * (`UEBERLAUF_TOEPFE` = §45b). Erst diese Paare werden durchgerechnet.
 * ERSETZT die Schleife über alle Kunden × 12 Monate (in Prod > 5 min ohne
 * Ausgabe, abgebrochen am 26.09.2026). `fortschritt` meldet jedes Paar.
 */
export async function zaehleUeberlauf(
  jahr: number,
  fortschritt: (zeile: string) => void = () => {},
): Promise<{ geprueft: number; treffer: Array<{ customerId: number; monat: number; privatErlaubt: boolean; probe: UeberlaufProbe }> }> {
  const zeilen = await db.selectDistinct({ customerId: budgetTransactions.customerId, datum: appointments.date })
    .from(budgetTransactions)
    .innerJoin(appointments, eq(appointments.id, budgetTransactions.appointmentId))
    .where(and(
      eq(budgetTransactions.transactionType, "consumption"),
      eq(budgetTransactions.budgetType, TOPF),
      isNull(appointments.deletedAt),
      gte(appointments.date, `${jahr}-01-01`),
      lte(appointments.date, `${jahr}-12-31`),
      sql`NOT EXISTS (SELECT 1 FROM budget_transactions r WHERE r.transaction_type = 'reversal' AND r.reversed_transaction_id = ${budgetTransactions.id})`,
      sql`${appointments.id} NOT IN (${activeInvoicedAppointmentIdsSqlRaw()})`,
    ));
  const paare = [...new Set(zeilen.map((z) => `${z.customerId}:${Number(String(z.datum).slice(5, 7))}`))]
    .map((k) => k.split(":").map(Number) as [number, number])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  fortschritt(`${paare.length} Kunde/Monat-Paare mit offenen §45b-Terminen (${new Set(paare.map((p) => p[0])).size} Kunden) — prüfe …`);

  const treffer: Array<{ customerId: number; monat: number; privatErlaubt: boolean; probe: UeberlaufProbe }> = [];
  let n = 0;
  for (const [id, monat] of paare) {
    n++;
    const probe = await probeUeberlauf(id, jahr, monat);
    if (probe.termine.length === 0) {
      fortschritt(`[${n}/${paare.length}] Kunde ${id} ${String(monat).padStart(2, "0")}/${jahr}: nicht überzogen`);
      continue;
    }
    // Ohne Privatzahlung bricht das Erstellen ab (RÜ-1) — getrennt ausweisen.
    const [k] = await db.select({ ok: customers.acceptsPrivatePayment }).from(customers).where(eq(customers.id, id));
    treffer.push({ customerId: id, monat, privatErlaubt: k?.ok === true, probe });
    fortschritt(`[${n}/${paare.length}] Kunde ${id} ${String(monat).padStart(2, "0")}/${jahr}: ÜBERZOGEN, ${probe.termine.length} Termine, Kasse ${euro(probe.kasseCents)} / privat ${euro(probe.privatCents)}${k?.ok ? "" : "  — KEINE Privatzahlung: Erstellen bricht ab (RÜ-1)"}`);
  }
  return { geprueft: new Set(paare.map((p) => p[0])).size, treffer };
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
    const t0 = Date.now();
    const { geprueft, treffer } = await zaehleUeberlauf(jahr, (z) => console.log(z));
    console.log(`\nFix greift bei ${new Set(treffer.map((t) => t.customerId)).size} Kunden in ${treffer.length} Monaten (${geprueft} Kunden mit offenen §45b-Terminen ${jahr} geprüft, ${Math.round((Date.now() - t0) / 1000)} s).`);
    console.log(`davon ohne Privatzahlung (nach Deploy nicht abrechenbar): ${new Set(treffer.filter((t) => !t.privatErlaubt).map((t) => t.customerId)).size} Kunden`);
    return;
  }
  const kundeId = Number(a); const jahr = Number(b); const monat = Number(c);
  const [kunde] = await db.select({ name: customers.name, privat: customers.acceptsPrivatePayment })
    .from(customers).where(eq(customers.id, kundeId));
  console.log(`Kunde ${kundeId}: ${kunde?.name ?? "?"} — Privatzahlung ${kunde?.privat ? "aktiviert" : "NICHT aktiviert"}`);
  // Startwerte und Überträge §45b des Jahres (auch gelöschte), damit klar ist, womit gerechnet wird.
  const zeilen = await db.select().from(budgetAllocations).where(and(
    eq(budgetAllocations.customerId, kundeId),
    eq(budgetAllocations.budgetType, TOPF),
    eq(budgetAllocations.year, jahr),
    inArray(budgetAllocations.source, ["initial_balance", "carryover"]),
  )).orderBy(asc(budgetAllocations.validFrom), asc(budgetAllocations.id));
  for (const z of zeilen) {
    const art = z.source === "initial_balance" ? "Startwert" : "Übertrag ";
    const monatsTreffer = z.source === "initial_balance" && z.month === monat ? `   <- Startwert ${String(monat).padStart(2, "0")}/${jahr}` : "";
    console.log(`  ${art} #${z.id}  ${euro(z.amountCents)}  ab ${z.validFrom}  eingetragen ${z.createdAt?.toISOString().slice(0, 10)}  ${z.createdByUserId == null ? "automatisch" : "von Hand"}  ${z.deletedAt ? `GELÖSCHT ${z.deletedAt.toISOString().slice(0, 10)}` : "aktiv"}${monatsTreffer}`);
  }
  const p = await probeUeberlauf(kundeId, jahr, monat);
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
