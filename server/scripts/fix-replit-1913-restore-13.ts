/**
 * Replit-#1913 — Einmal-Korrektur: 13 fälschlich rückwirkend abgesagte
 * Serientermine zurück auf `scheduled`.
 *
 * ── Der Vorfall ─────────────────────────────────────────────────────────
 * Beim Beenden bzw. Ändern einer Terminserie wurden auch BEREITS VERGANGENE
 * Termine mit abgesagt. Sie waren geleistet, aber nie dokumentiert; die
 * Mitarbeiterinnen kamen nach der Absage nicht mehr an sie heran. Betroffen:
 * 13 Termine aus 3 Serien, 1080 Minuten, rund 684,00 € Leistungswert.
 *
 * Die URSACHE (fehlender Datums-Boden auf den Routen `cancel` und `update`)
 * wird getrennt behoben. Dieses Skript räumt nur den entstandenen Schaden auf.
 *
 * ── Was es NICHT tut ────────────────────────────────────────────────────
 *  - Es dokumentiert nicht. Nach dem Lauf stehen die Termine wieder als
 *    `scheduled`; erfassen und unterschreiben müssen die Mitarbeiterinnen.
 *  - Es rechnet nicht ab und rührt keine Rechnung an.
 *  - Es hebt KEINEN Monatsabschluss auf und schreibt in keinen geschlossenen
 *    Monat. Bewusst kein Override (Entscheidung Alrik, 17.08.2026): die
 *    betroffenen Mitarbeiter-Monate werden vorher von der GF FORMAL wieder
 *    geöffnet — auditierbar. Ein Skript, das sich still über den Abschluss
 *    hinwegsetzt, wäre genau die stille Schreiboperation, gegen die der
 *    ganze Vorgang läuft. Ist ein Monat noch zu, wird der Termin
 *    ÜBERSPRUNGEN, nicht erzwungen.
 *  - Es gibt den Hold auf Termin 923 (57,00 €) NICHT frei. Der galt bisher
 *    als Waise (`sweepOrphanHolds` meldet „storniert + Hold"), weil sein
 *    Termin abgesagt war. Lebt der Termin wieder, ist der Hold korrekt.
 *
 * ── Guards ──────────────────────────────────────────────────────────────
 * Fingerabdruck-Prüfung je Termin (Datum, Dauer, Serie, Kraft, Kunde) gegen
 * die unten fest verdrahtete Tabelle. Eine ID allein genügt NICHT: die Liste
 * stammt aus der pseudonymisierten Referenz-Kopie, geschrieben wird auf
 * Produktion. Weicht eine Zeile ab, bricht der Lauf ab, statt zu raten.
 *
 * Übersprungen (nicht abgebrochen) wird ein Termin, der inzwischen
 * weitergezogen ist: gelöscht, nicht mehr `cancelled`, begonnen/unterschrieben,
 * auf einem Leistungsnachweis, abgerechnet — oder in einem noch geschlossenen
 * Monat.
 *
 * ── Ausführung ──────────────────────────────────────────────────────────
 *   tsx server/scripts/fix-replit-1913-restore-13.ts            # Trockenlauf
 *   tsx server/scripts/fix-replit-1913-restore-13.ts --apply    # schreibend
 *
 * Der schreibende Lauf gehört auf REPLIT (Produktion), nicht auf die Box.
 * Reihenfolge: verify.sql auf Prod → Monate öffnen → Trockenlauf → Freigabe →
 * `--apply` → Mitarbeiterinnen dokumentieren → Monate wieder schließen.
 *
 * Nach „angewendet + verifiziert" wird diese Datei GELÖSCHT und durch
 * `docs/corrections/2026-08-17_replit-1913-13-termine.md` ersetzt (CLAUDE.md).
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  invoiceLineItems,
  monthlyServiceRecords,
  serviceRecordAppointments,
} from "@shared/schema";
import { appointmentsRepo } from "../repos";
import { auditService } from "../services/audit";
import { isMonthClosed } from "../storage/time-tracking/month-closing";

/** Wer den Lauf verantwortet — landet im Audit-Eintrag. */
const ACTING_USER_ID = Number(process.env.REPLIT_1913_ACTOR_USER_ID ?? "1");

interface Fingerprint {
  id: number;
  date: string;
  durationPromised: number;
  seriesId: number;
  employeeId: number;
  customerId: number;
}

/**
 * Die 13. Erhoben aus der Referenz-Kopie und über verify.sql auf Produktion
 * bestätigt. Reihenfolge = Serie, dann Datum.
 */
const ZIELE: Fingerprint[] = [
  // Serie 6 — 9 Termine, 90 Min., Kraft 11 / Kunde 68
  { id: 915, date: "2026-05-13", durationPromised: 90, seriesId: 6, employeeId: 11, customerId: 68 },
  { id: 917, date: "2026-05-27", durationPromised: 90, seriesId: 6, employeeId: 11, customerId: 68 },
  { id: 918, date: "2026-06-03", durationPromised: 90, seriesId: 6, employeeId: 11, customerId: 68 },
  { id: 919, date: "2026-06-10", durationPromised: 90, seriesId: 6, employeeId: 11, customerId: 68 },
  { id: 922, date: "2026-07-01", durationPromised: 90, seriesId: 6, employeeId: 11, customerId: 68 },
  { id: 923, date: "2026-07-08", durationPromised: 90, seriesId: 6, employeeId: 11, customerId: 68 },
  { id: 924, date: "2026-07-15", durationPromised: 90, seriesId: 6, employeeId: 11, customerId: 68 },
  { id: 925, date: "2026-07-22", durationPromised: 90, seriesId: 6, employeeId: 11, customerId: 68 },
  { id: 926, date: "2026-07-29", durationPromised: 90, seriesId: 6, employeeId: 11, customerId: 68 },
  // Serie 12 — 1 Termin, 90 Min., Kraft 24 / Kunde 173
  { id: 1123, date: "2026-05-20", durationPromised: 90, seriesId: 12, employeeId: 24, customerId: 173 },
  // Serie 18 — 3 Termine, 60 Min., Kraft 21 / Kunde 217
  { id: 1754, date: "2026-07-13", durationPromised: 60, seriesId: 18, employeeId: 21, customerId: 217 },
  { id: 1755, date: "2026-07-20", durationPromised: 60, seriesId: 18, employeeId: 21, customerId: 217 },
  { id: 1756, date: "2026-07-27", durationPromised: 60, seriesId: 18, employeeId: 21, customerId: 217 },
];

/** Summenprobe aus dem Ticket — stimmt sie nicht, ist die Liste falsch. */
const ERWARTETE_MINUTEN = 1080;

type Befund =
  | { id: number; aktion: "restore"; date: string }
  | { id: number; aktion: "skip"; date: string; grund: string };

function abbruch(nachricht: string): never {
  console.error(`\nABBRUCH: ${nachricht}`);
  console.error("Es wurde nichts geschrieben.");
  process.exit(1);
}

async function pruefe(): Promise<Befund[]> {
  const ids = ZIELE.map(z => z.id);

  const minuten = ZIELE.reduce((s, z) => s + z.durationPromised, 0);
  if (minuten !== ERWARTETE_MINUTEN) {
    abbruch(`Zielliste ergibt ${minuten} Minuten, erwartet ${ERWARTETE_MINUTEN}. Liste angefasst?`);
  }

  const rows = await appointmentsRepo
    .selectFrom(db)
    .where(and(inArray(appointments.id, ids), isNull(appointments.deletedAt)));
  const beiId = new Map(rows.map(r => [r.id, r]));

  // Zeilen, die auf einem Leistungsnachweis liegen bzw. abgerechnet sind —
  // in einem Rutsch, nicht je Termin.
  const lnZeilen = await db
    .select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .where(inArray(serviceRecordAppointments.appointmentId, ids));
  const imLn = new Set(lnZeilen.map(z => z.appointmentId));

  const gesperrteLn = await db
    .select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .innerJoin(monthlyServiceRecords, eq(monthlyServiceRecords.id, serviceRecordAppointments.serviceRecordId))
    .where(and(
      inArray(serviceRecordAppointments.appointmentId, ids),
      isNull(monthlyServiceRecords.deletedAt),
      inArray(monthlyServiceRecords.status, ["employee_signed", "completed"]),
    ));
  const lnGesperrt = new Set(gesperrteLn.map(z => z.appointmentId));

  const rechnungen = await db
    .select({ appointmentId: invoiceLineItems.appointmentId })
    .from(invoiceLineItems)
    .where(inArray(invoiceLineItems.appointmentId, ids));
  const berechnet = new Set(rechnungen.map(z => z.appointmentId));

  const befunde: Befund[] = [];

  for (const ziel of ZIELE) {
    const row = beiId.get(ziel.id);
    if (!row) {
      befunde.push({ id: ziel.id, aktion: "skip", date: ziel.date, grund: "nicht gefunden oder gelöscht" });
      continue;
    }

    // ── Fingerabdruck: harter Abbruch, kein Skip ──────────────────────────
    // Ein Treffer auf der falschen Zeile ist kein „überspringen wir halt",
    // sondern heißt, dass die ID-Zuordnung nicht stimmt. Dann darf der ganze
    // Lauf nicht weiterlaufen.
    const abweichungen: string[] = [];
    if (row.date !== ziel.date) abweichungen.push(`Datum ${row.date} statt ${ziel.date}`);
    if (row.durationPromised !== ziel.durationPromised) {
      abweichungen.push(`Dauer ${row.durationPromised} statt ${ziel.durationPromised}`);
    }
    if (row.seriesId !== ziel.seriesId) abweichungen.push(`Serie ${row.seriesId} statt ${ziel.seriesId}`);
    if (row.assignedEmployeeId !== ziel.employeeId) {
      abweichungen.push(`Kraft ${row.assignedEmployeeId} statt ${ziel.employeeId}`);
    }
    if (row.customerId !== ziel.customerId) {
      abweichungen.push(`Kunde ${row.customerId} statt ${ziel.customerId}`);
    }
    if (abweichungen.length > 0) {
      abbruch(`Termin ${ziel.id} passt nicht zum Fingerabdruck: ${abweichungen.join(", ")}.`);
    }

    // ── Weitergezogen? → überspringen ─────────────────────────────────────
    if (row.status !== "cancelled") {
      befunde.push({ id: ziel.id, aktion: "skip", date: ziel.date, grund: `Status ist ${row.status}, nicht mehr cancelled` });
      continue;
    }
    if (row.actualStart || row.actualEnd) {
      befunde.push({ id: ziel.id, aktion: "skip", date: ziel.date, grund: "wurde inzwischen begonnen" });
      continue;
    }
    if (row.signedAt) {
      befunde.push({ id: ziel.id, aktion: "skip", date: ziel.date, grund: "trägt eine Unterschrift" });
      continue;
    }
    if (lnGesperrt.has(ziel.id)) {
      befunde.push({ id: ziel.id, aktion: "skip", date: ziel.date, grund: "auf unterschriebenem Leistungsnachweis" });
      continue;
    }
    if (imLn.has(ziel.id)) {
      befunde.push({ id: ziel.id, aktion: "skip", date: ziel.date, grund: "auf einem Leistungsnachweis" });
      continue;
    }
    if (berechnet.has(ziel.id)) {
      befunde.push({ id: ziel.id, aktion: "skip", date: ziel.date, grund: "abgerechnet" });
      continue;
    }

    // ── Monatsabschluss: kein Override ────────────────────────────────────
    if (row.assignedEmployeeId && await isMonthClosed(row.assignedEmployeeId, row.date)) {
      befunde.push({
        id: ziel.id,
        aktion: "skip",
        date: ziel.date,
        grund: `Monat ${ziel.date.slice(0, 7)} für Kraft ${row.assignedEmployeeId} ist geschlossen — erst formal öffnen`,
      });
      continue;
    }

    befunde.push({ id: ziel.id, aktion: "restore", date: ziel.date });
  }

  return befunde;
}

async function main() {
  const apply = process.argv.includes("--apply");

  console.log("Replit-#1913 — Wiederherstellung der 13 rückwirkend abgesagten Termine");
  console.log(apply ? "MODUS: SCHREIBEND (--apply)\n" : "MODUS: Trockenlauf (kein --apply)\n");

  const befunde = await pruefe();
  const zuTun = befunde.filter(b => b.aktion === "restore");
  const skips = befunde.filter(b => b.aktion === "skip");

  for (const b of befunde) {
    if (b.aktion === "restore") console.log(`  #${b.id}  ${b.date}  cancelled → scheduled`);
    else console.log(`  #${b.id}  ${b.date}  ÜBERSPRUNGEN: ${b.grund}`);
  }

  console.log(`\n  wiederherstellbar: ${zuTun.length}   übersprungen: ${skips.length}   gesamt: ${befunde.length}`);

  if (!apply) {
    console.log("\nTrockenlauf beendet. Nichts geschrieben.");
    if (skips.length > 0) {
      console.log("Übersprungene zuerst klären (Monate öffnen o.ä.) — sonst bleiben sie liegen.");
    }
    return;
  }

  if (zuTun.length === 0) {
    console.log("\nNichts zu tun.");
    return;
  }

  await db.transaction(async tx => {
    for (const b of zuTun) {
      await tx.update(appointments).set({ status: "scheduled" }).where(eq(appointments.id, b.id));
      await auditService.log(
        ACTING_USER_ID,
        "appointment_updated",
        "appointment",
        b.id,
        {
          korrektur: "Replit-1913",
          grund: "Rückwirkend fälschlich abgesagter Serientermin — auf scheduled zurückgesetzt, damit die Leistung dokumentiert werden kann.",
          vorher: { status: "cancelled" },
          nachher: { status: "scheduled" },
          monatsabschlussUebergangen: false,
        },
      );
    }
  });

  console.log(`\n${zuTun.length} Termine zurückgesetzt. Die Mitarbeiterinnen können jetzt dokumentieren.`);
  console.log("Danach: Monate wieder schließen, dieses Skript löschen, Protokoll unter docs/corrections/ ablegen.");
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
