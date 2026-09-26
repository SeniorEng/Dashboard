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
import { neuzubuchendeTermine, getServiceRecordsForPeriod, getAppointmentIdsFromServiceRecords, getAlreadyInvoicedAppointmentIds } from "../services/invoice-data";
import { isServiceRecordSignedForBilling } from "@shared/domain/billing-eligibility";
import { readUnifiedBudgetAvailability } from "../storage/budget/unified-reader";
import { activeInvoicedAppointmentIdsSqlRaw } from "../lib/appointment-invoiced";

const TOPF = "entlastungsbetrag_45b";

export interface UeberlaufProbe {
  termine: Array<{ id: number; datum: string; kostenCents: number; kasseCents: number; privatCents: number; exakt: boolean }>;
  kasseCents: number;
  privatCents: number;
  nettoNullOhneProbe: number[];
  /** Auswahl wie `buildInvoiceDraft`: Termine unter signierten LN, davon abgerechnet, davon im Lauf. */
  auswahl: { lnTermine: number; abgerechnet: number; lauf: number[] };
  /** Rechenweg je Buchungstag der lebenden §45b-Buchungen der Lauf-Termine (Reader, wie `neuzubuchendeTermine`). */
  rechenweg: Array<{ datum: string; zugewiesenCents: number; verbrauchCents: number; saldoCents: number }>;
  /** Lebende §45b-Buchungen der Lauf-Termine. */
  buchungen: Array<{ id: number; terminId: number; datum: string; betragCents: number; zuweisungId: number | null }>;
}

/**
 * Die Termine, die ein Abrechnungslauf für (Kunde, Monat) anfassen würde —
 * DIESELBE Auswahl wie `buildInvoiceDraft` (`invoice-calc.ts`): Termine unter
 * abrechnungsreif signierten Leistungsnachweisen des Monats, minus die bereits
 * abgerechneten. ERSETZT „jeder Termin des Monats ohne aktive Rechnungszeile"
 * (Prod-Messung 26.09.2026: 267 Paare, fast alle längst abgerechnete Monate).
 */
async function laufTermine(customerId: number, jahr: number, monat: number): Promise<{ lnTermine: number; abgerechnet: number; lauf: number[] }> {
  const [kunde] = await db.select({ billingType: customers.billingType }).from(customers).where(eq(customers.id, customerId));
  const lns = (await getServiceRecordsForPeriod(customerId, jahr, monat))
    .filter((sr) => isServiceRecordSignedForBilling(kunde?.billingType, sr.status));
  if (lns.length === 0) return { lnTermine: 0, abgerechnet: 0, lauf: [] };
  const alle = await getAppointmentIdsFromServiceRecords(lns.map((sr) => sr.id));
  const abgerechnet = new Set(await getAlreadyInvoicedAppointmentIds(alle));
  return { lnTermine: alle.length, abgerechnet: abgerechnet.size, lauf: alle.filter((id) => !abgerechnet.has(id)) };
}

export async function probeUeberlauf(customerId: number, jahr: number, monat: number): Promise<UeberlaufProbe> {
  const auswahl = await laufTermine(customerId, jahr, monat);
  const ids = auswahl.lauf;
  const { nettoNull, ueberzogen } = await neuzubuchendeTermine(customerId, ids);

  // Rechenweg: lebende §45b-Buchungen der Lauf-Termine und der Reader an ihren Buchungstagen.
  const alleBuchungen = ids.length === 0 ? [] : await db.select().from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    inArray(budgetTransactions.appointmentId, ids),
    inArray(budgetTransactions.transactionType, ["consumption", "reversal"]),
  ));
  const storniertAlle = new Set(alleBuchungen.filter((b) => b.transactionType === "reversal").map((b) => b.reversedTransactionId));
  const lebend45b = alleBuchungen
    .filter((b) => b.transactionType === "consumption" && b.budgetType === TOPF && !storniertAlle.has(b.id))
    .map((b) => ({ id: b.id, terminId: b.appointmentId as number, datum: String(b.transactionDate), betragCents: -b.amountCents, zuweisungId: b.allocationId }))
    .sort((x, y) => x.datum.localeCompare(y.datum) || x.id - y.id);
  const rechenweg: UeberlaufProbe["rechenweg"] = [];
  for (const datum of [...new Set(lebend45b.map((b) => b.datum))]) {
    const t = (await readUnifiedBudgetAvailability(customerId, datum)).pots.entlastungsbetrag_45b;
    rechenweg.push({ datum, zugewiesenCents: t.allocatedCents, verbrauchCents: t.consumedNetCents, saldoCents: t.allocatedCents - t.consumedNetCents });
  }

  const leer: UeberlaufProbe = { termine: [], kasseCents: 0, privatCents: 0, nettoNullOhneProbe: nettoNull, auswahl, rechenweg, buchungen: lebend45b };
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
    inArray(budgetAllocations.source, ["initial_balance", "carryover", "manual_adjustment"]),
  )).orderBy(asc(budgetAllocations.validFrom), asc(budgetAllocations.id));
  for (const z of zeilen) {
    const art = z.source === "initial_balance" ? "Startwert" : z.source === "carryover" ? "Übertrag " : "Korrektur";
    const monatsTreffer = z.source === "initial_balance" && z.month === monat ? `   <- Startwert ${String(monat).padStart(2, "0")}/${jahr}` : "";
    console.log(`  ${art} #${z.id}  ${euro(z.amountCents)}  ab ${z.validFrom}  eingetragen ${z.createdAt?.toISOString().slice(0, 10)}  ${z.createdByUserId == null ? "automatisch" : "von Hand"}  ${z.deletedAt ? `GELÖSCHT ${z.deletedAt.toISOString().slice(0, 10)}` : "aktiv"}${monatsTreffer}`);
  }
  const p = await probeUeberlauf(kundeId, jahr, monat);
  const mm = `${String(monat).padStart(2, "0")}/${jahr}`;
  console.log(`Termine unter signiertem LN ${mm}: ${p.auswahl.lnTermine}, davon abgerechnet ${p.auswahl.abgerechnet}, im Lauf ${p.auswahl.lauf.length}`);
  for (const b of p.buchungen) {
    console.log(`  Buchung #${b.id}  Termin ${b.terminId}  ${b.datum}  ${euro(b.betragCents)}  Zuweisung ${b.zuweisungId ?? "–"}`);
  }
  console.log(`Rechenweg §45b (Reader, je Buchungstag): zugewiesen − Verbrauch = Saldo`);
  for (const r of p.rechenweg) {
    console.log(`  ${r.datum}: ${euro(r.zugewiesenCents)} − ${euro(r.verbrauchCents)} = ${euro(r.saldoCents)}${r.saldoCents < 0 ? "   ÜBERZOGEN" : ""}`);
  }
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
